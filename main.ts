// main.ts is mend, the CLI SPEC.md specifies (MIT).
// Implements all sections of SPEC.md: CLI flags, output & exit codes, safe paths,
// format detection, 3-tier line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits, and atomic apply.
// Node 22+, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

// --- Section 4: Format detection ---

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Section 5: Matching lines ---

function normLine(line: string, tier: 0 | 1 | 2): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function leadingSpacesTabs(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return line.slice(0, i);
}

type NewItem = { kind: 'ctx'; oIdx: number } | { kind: 'add'; text: string };

function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startIdx = 0,
  endOnly = false
): { tier: 0 | 1 | 2; positions: number[] } | null {
  const maxTier: 0 | 2 = strict ? 0 : 2;
  const k = oldLines.length;
  if (k === 0) return null;
  const maxPos = fileLines.length - k;
  if (maxPos < startIdx) return null;

  for (let t = 0; t <= maxTier; t += 1) {
    const tier = t as 0 | 1 | 2;
    const normOld = oldLines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    const from = endOnly ? maxPos : startIdx;
    const to = maxPos;
    for (let i = from; i <= to; i += 1) {
      let ok = true;
      for (let j = 0; j < k; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normOld[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newItems: NewItem[],
  tier: 0 | 1 | 2
): string[] {
  const F = tier === 2 ? leadingSpacesTabs(fileLines[pos]!) : '';
  const P = tier === 2 ? leadingSpacesTabs(oldLines[0]!) : '';
  const out: string[] = [];
  for (const item of newItems) {
    if (item.kind === 'ctx') {
      out.push(fileLines[pos + item.oIdx]!);
    } else if (tier === 2 && !blank(item.text) && item.text.startsWith(P)) {
      out.push(F + item.text.slice(P.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// --- Section 6: Unified diffs ---

interface UnifiedHunk {
  oldStart: number;
  oldLines: string[];
  newItems: NewItem[];
  plusLines: string[];
  noFinalBreak: boolean;
  lastPlusNoNewline: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedPath(line: string): string {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  let p = raw.replace(/^ +| +$/g, '');
  if (p !== '/dev/null' && (p.startsWith('a/') || p.startsWith('b/'))) {
    p = p.slice(2);
  }
  return p;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isMinusPlusAt = (idx: number): boolean =>
    idx + 1 < lines.length && lines[idx]!.startsWith('--- ') && lines[idx + 1]!.startsWith('+++ ');

  while (i < lines.length) {
    const l = lines[i]!;

    if (isDiffGit(l)) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        minusPath: null,
        plusPath: null,
        renameFrom: null,
        renameTo: null,
        newFileMode: false,
        deletedFileMode: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }

    if (l.startsWith('--- ')) {
      if (inHeader && cur !== null && cur.minusPath === null) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        cur.minusPath = parseUnifiedPath(l);
        cur.plusPath = parseUnifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (isMinusPlusAt(i)) {
        cur = {
          gitOld: null,
          gitNew: null,
          minusPath: parseUnifiedPath(l),
          plusPath: parseUnifiedPath(lines[i + 1]!),
          renameFrom: null,
          renameTo: null,
          newFileMode: false,
          deletedFileMode: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      // Outside section header (or after ---/+++ already seen) without +++: ignored as prose
      i += 1;
      continue;
    }

    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;

      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (isDiffGit(bl) || isMinusPlusAt(i)) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') {
        rawBody.pop();
      }

      const oldLines: string[] = [];
      const newItems: NewItem[] = [];
      const plusLines: string[] = [];
      let lastKind: 'ctx' | 'old' | 'add' | null = null;
      let noFinalBreak = false;
      let lastPlusNoNewline = false;

      for (const bl of rawBody) {
        if (bl === '') {
          const oIdx = oldLines.length;
          oldLines.push('');
          newItems.push({ kind: 'ctx', oIdx });
          lastKind = 'ctx';
          noFinalBreak = false;
        } else if (bl[0] === ' ') {
          const text = bl.slice(1);
          const oIdx = oldLines.length;
          oldLines.push(text);
          newItems.push({ kind: 'ctx', oIdx });
          lastKind = 'ctx';
          noFinalBreak = false;
        } else if (bl[0] === '-') {
          oldLines.push(bl.slice(1));
          lastKind = 'old';
        } else if (bl[0] === '+') {
          const text = bl.slice(1);
          newItems.push({ kind: 'add', text });
          plusLines.push(text);
          lastKind = 'add';
          noFinalBreak = false;
          lastPlusNoNewline = false;
        } else if (bl[0] === '\\') {
          if (lastKind === 'ctx' || lastKind === 'add') {
            noFinalBreak = true;
          }
          if (lastKind === 'add') {
            lastPlusNoNewline = true;
          }
        }
      }

      cur.hunks.push({ oldStart, oldLines, newItems, plusLines, noFinalBreak, lastPlusNoNewline });
      continue;
    }

    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFileMode = true;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFileMode = true;
      }
    }

    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.newFileMode;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.deletedFileMode);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      return (tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const allPlus: string[] = [];
        let lastNoNewline = false;
        for (const h of sec.hunks) {
          if (h.plusLines.length > 0) {
            allPlus.push(...h.plusLines);
            lastNoNewline = h.lastPlusNoNewline;
          }
        }
        tree.now.set(newPath, joinFile({ br: '\n', lines: allPlus, final: !lastNoNewline }));
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }

    return (tree, strict) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = splitFile(before);
      let d = 0;

      for (const h of sec.hunks) {
        if (h.oldLines.length > 0) {
          const found = findOccurrences(file.lines, h.oldLines, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.oldStart - 1 + d;
          let bestPos = found.positions[0]!;
          let bestDist = Math.abs(bestPos - target);
          for (let k = 1; k < found.positions.length; k += 1) {
            const p = found.positions[k]!;
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const atEnd = bestPos + h.oldLines.length === file.lines.length;
          const repl = buildReplacement(file.lines, bestPos, h.oldLines, h.newItems, found.tier);
          file.lines.splice(bestPos, h.oldLines.length, ...repl);
          if (atEnd) file.final = !h.noFinalBreak;
          d += repl.length - h.oldLines.length;
        } else {
          const insertPos = Math.max(0, Math.min(file.lines.length, h.oldStart + d));
          const atEnd = insertPos === file.lines.length;
          const add = h.newItems.map((it) => (it.kind === 'add' ? it.text : ''));
          file.lines.splice(insertPos, 0, ...add);
          if (atEnd) file.final = !h.noFinalBreak;
          d += add.length;
        }
      }

      const out = joinFile(file);
      if (isMove) {
        tree.now.set(newPath, out);
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

// --- Section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let lastReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let blockPath: string | null = null;
    for (let j = searchIdx - 1; j > lastReplaceIdx; j -= 1) {
      if (!blank(lines[j]!) && !lines[j]!.trim().startsWith('```')) {
        blockPath = lines[j]!.trim();
        break;
      }
    }
    if (blockPath === null) {
      if (prevPath !== null) blockPath = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }

    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let endIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    const p = blockPath;
    prevPath = blockPath;
    lastReplaceIdx = endIdx;
    i = endIdx + 1;

    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ br: '\n', lines: newLines, final: true }));
      });
    } else {
      const newItems: NewItem[] = newLines.map((text) => ({ kind: 'add', text }));
      edits.push((tree, strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const file = splitFile(before);
        const found = findOccurrences(file.lines, oldLines, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.positions.length > 1) throw new Fail('ambiguous', p);
        const pos = found.positions[0]!;
        const repl = buildReplacement(file.lines, pos, oldLines, newItems, found.tier);
        file.lines.splice(pos, oldLines.length, ...repl);
        tree.now.set(p, joinFile(file));
      });
    }
  }

  return edits;
}

// --- Section 8: V4A patches ---

interface V4AChunk {
  anchor: string | null;
  oldLines: string[];
  newItems: NewItem[];
  eof: boolean;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    if (!blank(lines[idx]!)) {
      last = idx;
      break;
    }
  }
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const headerLine = lines[i]!;
    const headerLineNum = i + 1;
    if (!isSectionHeader(headerLine)) {
      throw new Exit2(`error: parse ${headerLineNum}`);
    }

    const bodyStart = i + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < last && !isSectionHeader(lines[bodyEnd]!)) {
      bodyEnd += 1;
    }
    // Strip trailing blank lines at the end of the section
    let trimmedEnd = bodyEnd;
    while (trimmedEnd > bodyStart && blank(lines[trimmedEnd - 1]!)) {
      trimmedEnd -= 1;
    }
    i = bodyEnd;

    if (headerLine.startsWith('*** Add File: ')) {
      const p = headerLine.slice('*** Add File: '.length).replace(/^ +| +$/g, '');
      const addLines: string[] = [];
      for (let j = bodyStart; j < trimmedEnd; j += 1) {
        const bl = lines[j]!;
        if (bl.startsWith('+')) addLines.push(bl.slice(1));
        else if (bl === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ br: '\n', lines: addLines, final: true }));
      });
    } else if (headerLine.startsWith('*** Delete File: ')) {
      const p = headerLine.slice('*** Delete File: '.length).replace(/^ +| +$/g, '');
      if (trimmedEnd > bodyStart) {
        throw new Exit2(`error: parse ${bodyStart + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      // *** Update File: <path>
      const p = headerLine.slice('*** Update File: '.length).replace(/^ +| +$/g, '');
      let j = bodyStart;
      let moveTo: string | null = null;
      if (j < trimmedEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).replace(/^ +| +$/g, '');
        j += 1;
      }

      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      let chunkClosed = false;

      while (j < trimmedEnd) {
        const bl = lines[j]!;
        if (bl.startsWith('@@')) {
          const anchorText = bl.slice(2).replace(/^ +| +$/g, '');
          curChunk = {
            anchor: anchorText === '' ? null : anchorText,
            oldLines: [],
            newItems: [],
            eof: false,
          };
          chunks.push(curChunk);
          chunkClosed = false;
          j += 1;
        } else if (bl === '*** End of File') {
          if (curChunk === null || chunkClosed) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          chunkClosed = true;
          j += 1;
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            curChunk = { anchor: null, oldLines: [], newItems: [], eof: false };
            chunks.push(curChunk);
          } else if (chunkClosed) {
            throw new Exit2(`error: parse ${j + 1}`);
          }
          if (bl === '') {
            const oIdx = curChunk.oldLines.length;
            curChunk.oldLines.push('');
            curChunk.newItems.push({ kind: 'ctx', oIdx });
          } else if (bl[0] === ' ') {
            const text = bl.slice(1);
            const oIdx = curChunk.oldLines.length;
            curChunk.oldLines.push(text);
            curChunk.newItems.push({ kind: 'ctx', oIdx });
          } else if (bl[0] === '-') {
            curChunk.oldLines.push(bl.slice(1));
          } else {
            curChunk.newItems.push({ kind: 'add', text: bl.slice(1) });
          }
          j += 1;
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${headerLineNum}`);
      }

      edits.push((tree, strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const file = splitFile(before);
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const foundAnchor = findOccurrences(file.lines, [ch.anchor], strict, cursor, false);
            if (foundAnchor === null) throw new Fail('no-match', p);
            cursor = foundAnchor.positions[0]! + 1;
          }
          if (ch.oldLines.length > 0) {
            const found = findOccurrences(file.lines, ch.oldLines, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            const repl = buildReplacement(file.lines, pos, ch.oldLines, ch.newItems, found.tier);
            file.lines.splice(pos, ch.oldLines.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const insertPos = ch.eof ? file.lines.length : cursor;
            const add = ch.newItems.map((it) => (it.kind === 'add' ? it.text : ''));
            file.lines.splice(insertPos, 0, ...add);
            cursor = insertPos + add.length;
          }
        }

        const out = joinFile(file);
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(p, null);
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }

  return edits;
}

// --- Section 9: JSON edits ---

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(file));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 1, 2, 10: CLI & atomic apply ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Build output rows, handling moves R <old> -> <new>
  const paired = new Set<string>();
  const rowEntries: Array<{ key: string; line: string }> = [];

  for (let m = tree.moves.length - 1; m >= 0; m -= 1) {
    const [oldP, newP] = tree.moves[m]!;
    if (paired.has(oldP) || paired.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      paired.add(oldP);
      paired.add(newP);
      rowEntries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }

  const toDelete: string[] = [];
  const toWrite: Array<[string, string]> = [];

  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!paired.has(p)) {
      rowEntries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    if (check) continue;
    if (now === null) toDelete.push(p);
    else toWrite.push([p, now]);
  }

  for (const p of toDelete) {
    rmSync(p, { force: true });
  }
  for (const [p, content] of toWrite) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  rowEntries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowEntries.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
