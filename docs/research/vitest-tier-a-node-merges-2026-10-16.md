---
type: report
title: Vitest Tier A Node Directory Merges
created: 2026-10-16
tags:
  - vitest
  - performance
  - test-consolidation
related:
  - '[[vitest-tier-a-before-state-2026-10-15]]'
  - '[[vitest-tier-a-jsdom-merges-2026-10-16]]'
  - '[[01 - Tier A Small-Average Directories]]'
---

# Tier A node directory merges

Suite-layout changes only: imports are combined, colliding module-local bindings are mechanically renamed, and file-level lifecycle hooks are scoped to their original top-level suites. Test bodies and full assertion names are preserved. Identical capture-free mock factories can be shared; competing factories and captured mock state remain isolated. No application code or shared Vitest configuration changes.

All playbook Vitest commands use command-scoped `NODE_ENV=test` and the approved newline-safe filter `^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$`. Expected full-suite totals: **45,524 passed / 0 failed / 119 skipped out of 45,643 tests**. These are filtered results, not unfiltered coverage.

The preceding jsdom checkbox lists nine directories; this checkbox lists eleven. This report numbers the actual directory sequence **10–20**, rather than treating the checkbox's historical “Stages 11–20” label as ten directories.

## Directory gates

Counts use exact parent directories, excluding descendant suites. Each result is compared with the approved pre-node JSON receipt as a sorted multiset of assertion full names and statuses, not merely a total count. File-count targets in the Read Me are estimates; factory and lifecycle boundaries take precedence.

| Stage | Directory under `src/__tests__` | Files before → after | Exact assertions       | Directory wall | Isolation notes                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------- | -------------------- | ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | `main/cue/triggers`             | 9 → 2                | 88 passed              | 0.450s         | Temporal/registry and provider-wrapper clusters keep competing provider factories separate.                                                                                                                                                                                                                                                                       |
| 11    | `main/stores`                   | 15 → 7               | 241 passed             | 2.57s          | A trial Claude-usage/deferred-write merge produced two timeouts: the usage suite leaves fake timers active. Both originals restored verbatim. Electron-store factories with separate captured constructor state remain isolated. Descendants add 21 unchanged assertions to the directory invocation.                                                             |
| 12    | `main/coworking`                | 12 → 4               | 125 passed             | 0.357s         | Browser-bridge tools and socket-path Electron factories remain separate; identical capture-free bridge/audit factories deduplicated. Descendants add 17 unchanged assertions to the directory invocation.                                                                                                                                                         |
| 13    | `main/storage`                  | 12 → 8               | 212 passed             | 0.596s         | A trial Claude/image-store merge produced seven failures because Claude's `fs/promises` mock replaced real image writes. Both original files restored verbatim. Distinct filesystem, Electron, and remote-storage factories remain separate.                                                                                                                      |
| 14    | `main/stats`                    | 18 → 12              | 420 passed             | 1.80s          | Captured SQLite/filesystem fixtures, the readonly-query factory, and the node-environment migration suite remain isolated where necessary. `integration.test.ts` remains unchanged on jsdom. Descendants add 38 unchanged assertions to the directory invocation.                                                                                                 |
| 15    | `main/agents`                   | 26 → 11              | 778 passed / 3 skipped | 7.51s          | Usage sampler/startup factories stay in separate clusters; the oversized session-storage suite and incompatible detection/path/provider fixtures remain unmerged.                                                                                                                                                                                                 |
| 16    | `main`                          | 32 → 21              | 955 passed / 1 skipped | 24.99s         | Discovery, lifecycle, configuration, watcher, external-integration, and remote domains split around incompatible factories. Existing oversized files stay unmerged. The root-directory command also runs descendants: 11,735 assertions in 397 files. An initial tool-timeout capture is partial and is not counted; the completed receipt is `stage16-complete`. |
| 17    | `main/ipc/handlers`             | 38 → 33              | 1,996 passed           | 3.66s          | Only four compatible clusters merged; oversized handlers and conflicting factories retained. A trial mixed value/type `Mock` import failed transformation; import deduplication corrected without modifying tests. Descendants add 11 unchanged assertions to the directory invocation.                                                                           |
| 18    | `shared/pianola`                | 16 → 3               | 374 passed             | 0.446s         | Classification/storage, orchestration/policy, and task/watcher domains; original suite-level lifecycles remain scoped.                                                                                                                                                                                                                                            |
| 19    | `cli/services`                  | 16 → 11              | 506 passed / 1 skipped | 1.29s          | Real run-storage fixtures stay apart from filesystem/storage mocks. Goal/refresh and sessions/client clusters keep incompatible batch, prompt, storage, and spawning factories isolated.                                                                                                                                                                          |
| 20    | `maestro-p`                     | 15 → 3               | 327 passed             | 0.675s         | Parsing/CLI, driver/prompts, and streaming/session domains; distinct PTY factories stay in different files.                                                                                                                                                                                                                                                       |

## Full-suite checkpoints

- After stages 10–11: **45,524 passed / 0 failed / 119 skipped; 1,593 files; 267.53s**. Receipts: `Working/vt-fu-a-node-checkpoint11.log` and `.json` in the shared playbook folder.
- After stages 12–13: **45,524 passed / 0 failed / 119 skipped; 1,581 files; 257.81s**. Receipts: `Working/vt-fu-a-node-checkpoint13.log` and `.json`.
- After stages 14–15: **45,524 passed / 0 failed / 119 skipped; 1,560 files; 285.11s**. Receipts: `Working/vt-fu-a-node-checkpoint15.log` and `.json`.
- After stages 16–17: **45,524 passed / 0 failed / 119 skipped; 1,544 files; 276.37s**. Receipts: `Working/vt-fu-a-node-checkpoint17.log` and `.json`.
- After stages 18–19: **45,524 passed / 0 failed / 119 skipped; 1,526 files; 276.27s**. Receipts: `Working/vt-fu-a-node-checkpoint19.log` and `.json`.
- After stage 20: **45,524 passed / 0 failed / 119 skipped out of 45,643 tests; 1,514 files; 273.62s**. Receipts: `Working/vt-fu-a-node-final.log` and `.json`.

Warnings and expected error-path diagnostics remain in the raw logs. Passing assertions are not a warning-free claim.

## Preservation and scope review

- All eleven exact-parent directory gates preserve **6,027 assertions: 6,022 passed and five skipped**, with identical full names and statuses.
- Exact-parent files decrease **209 → 115**, removing **94 node file floors**. There are **38 new merged files** and 77 retained originals. The largest new cluster is **1,426 lines**, below the 1,500-line cap.
- AST structural fingerprints preserve all **5,739 test callback bodies**, allowing mechanical identifier renames and equivalent shorthand-property expansion. Parameterized tests account for the difference between callback and assertion totals. Receipts: `Working/vt-fu-a-node-body-audit.json` for the first six changed directories and `Working/vt-fu-a-node-body-audit-remaining.json` for the remaining five.
- The final full-suite JSON has exactly the same **45,643 assertion full names and statuses** as the approved pre-node receipt, including duplicate-name multiplicities. Full-suite file count decreases **1,608 → 1,514**. Receipt: `Working/vt-fu-a-node-global-audit.json`; final profile SHA-256: `2b2269facb9ede10e957afcb5de0fab46b0b8ea5eba5514e2863d227204accb4`.
- Original source paths are listed in each merged file's header. Removed files contain no unique tests left outside the merged clusters. Competing mock factories, oversized fixtures, environment directives, and the two observed lifecycle/filesystem conflicts are retained instead of rewritten.
- Snapshot and file-identity searches found no `toMatchSnapshot`, `toMatchInlineSnapshot`, `__filename`, or `import.meta.url` dependencies in these targets.
- No application code, shared configuration, hook policy, assertions, skip declarations, or suite titles changed. `main/stats/integration.test.ts` still belongs to jsdom. Tier B roots are untouched.
- These are test-runner layout changes, not application behavior changes. The directory and full-suite commands exercise the changed Vitest surface; no desktop UI verification or measured speedup is claimed. Final Tier A timing/calibration and the later playbook checkboxes remain separate work.

## Static verification and review

- Prettier passed over all 38 new merged files and this report.
- Focused ESLint passed with `-c eslint.dashes.config.mjs --no-ignore` over the main test tree and the Pianola, CLI-service, and Maestro-P targets.
- All configured TypeScript checks passed: `tsc -p tsconfig.lint.json`, `tsc -p tsconfig.main.json --noEmit`, and `tsc -p tsconfig.cli.json --noEmit`.
- Static-check receipt: `Working/vt-fu-a-node-static-checks.log`.
- Review found no blocking issue in the final changes. It covered import aliases and type-import deduplication, mock captures and factory separation, lifecycle scoping, source-path sensitivity, line caps, assertion inventories, and the staged scope. The commit changes only the eleven target test directories and this report; no application API, production behavior, or top-level setup documentation requires an update.
