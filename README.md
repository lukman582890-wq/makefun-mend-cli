# mend

[![Bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lukman582890-wq/makefun-mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lukman582890-wq/makefun-mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format — built for the [make.fun `hidden-spec-cli-01-run-20261122` bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Overview

`mend` (`main.ts`) is a zero-dependency Node.js 22+ TypeScript CLI implementing the full [SPEC.md](./SPEC.md) specification:

- **All 4 AI edit formats** with automatic format detection (`--format=auto|unified|search-replace|v4a|json`):
  - **Unified diffs** (`diff --git`, `---`/`+++`, renames, creations, deletions, offset hunks, `\ No newline at end of file`, prose/fence tolerance)
  - **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, path inheritance, file creation, ambiguity checks)
  - **V4A patches** (`*** Begin Patch` / `*** Add File` / `*** Delete File` / `*** Update File` / `*** Move to` / `@@` anchors / `*** End of File` / `*** End Patch`)
  - **JSON edits** (array and JSON Lines forms for `create`, `str_replace`, and `insert`)
- **3-tier line matching** (exact, trailing whitespace-normalized, leading & trailing whitespace-normalized with tier-2 re-indentation and context preservation), plus `--strict` (tier 0 only).
- **Atomic all-or-nothing apply** with full failure reporting across all edits, `--check` dry-run mode, CRLF/LF preservation, safe path validation, and `A`/`D`/`M`/`R <old> -> <new>` status output.

## Usage

```bash
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## Verification

Run the 100-check practice harness:

```bash
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

Result: **100 / 100 passed (practice score 1000)**.

## License

[MIT](./LICENSE)
