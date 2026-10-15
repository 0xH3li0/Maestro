---
type: report
title: Vitest Tier A Before-State Capture
created: 2026-10-15
tags:
  - vitest
  - performance
  - baseline
related:
  - '[[01 - Tier A Small-Average Directories]]'
  - '[[04 - Final Verification and Measurement]]'
---

# Vitest Tier A before-state capture

Stage 0 of the Vitest Micro-Kill Followup playbook, loop 00001. Measured source revision: `20a1add52`, branch `auto-run-release/lite-fixed-20261012-1014`. No test, application, or configuration changes were made. This is a measurement record, not approval to merge suites or evidence of a green full suite.

## Method and artifacts

Ran the following sequentially from the repository root with Node `v25.6.1`, npm `11.9.0`, and the unchanged `vitest.config.mts` (`forks`, eight workers). Captures live in the permitted shared playbook Working directory rather than the template's `%TEMP%` location.

```bash
OUT="C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working"
npx vitest run --config vitest.config.mts > "$OUT/vt-fu-before-a.log" 2>&1
npx vitest run --config vitest.config.mts --reporter=json --outputFile="$OUT/vt-fu-prof-before-a.json" > "$OUT/vt-fu-prof-before-a.log" 2>&1
npx vitest run --config vitest.config.mts --project jsdom > "$OUT/vt-fu-before-a-jsdom.log" 2>&1
npx vitest run --config vitest.config.mts --project node > "$OUT/vt-fu-before-a-node.log" 2>&1
```

The first invocation was interrupted by a tool caller timeout before completion; its partial log was replaced by the completed capture above. No overlapping Vitest process remained when the completed sequence started.

The JSON reporter exposes assertion results, not per-project environment/import diagnostics. Split-project runs provide those phase sums, following the preceding playbook's measurement method. Do not compare their summed wall times with the combined run: the scheduling differs.

Profile SHA-256: `858765a95451a3444dacbda2d0593f305820f691e4ebd7b901883754b3d86461`.

## Full-suite invariant and phase sums

| Capture                   | Exit | Files passed / failed / skipped  | Tests passed / failed / skipped | Wall                         |
| ------------------------- | ---- | -------------------------------- | ------------------------------- | ---------------------------- |
| Combined default reporter | 1    | 1704 / 1 / 1 (1706 total)        | 45522 / 1 / 120 (45643 total)   | 273.36s                      |
| Combined JSON reporter    | 1    | 1704 / 1 / 1 (1706 file results) | 45522 / 1 / 120 (45643 total)   | Not emitted by JSON reporter |
| jsdom project             | 0    | 1074 / 0 / 1 (1075 total)        | 28004 / 0 / 108 (28112 total)   | 263.60s                      |
| node project              | 1    | 630 / 1 / 0 (631 total)          | 17518 / 1 / 12 (17531 total)    | 32.78s                       |

File counts use JSON `testResults` entries, not `numTotalTestSuites`, which includes nested suites. The JSON reporter labels the skipped-only file `passed` (raw statuses: 1705 passed, 1 failed); the table uses the default reporter's passed/failed/skipped classification for comparison. Test counts include skipped assertions. Combined and split test totals agree with the preceding playbook's final capture.

| Phase sum                                  | Baseline |
| ------------------------------------------ | -------- |
| jsdom `environment`                        | 642.34s  |
| jsdom `import`                             | 851.65s  |
| node `import`                              | 70.76s   |
| Combined-run `environment` (both projects) | 592.28s  |
| Combined-run `import` (both projects)      | 855.48s  |

Phase sums aggregate worker activity, not elapsed wall time. Split and combined sums differ with contention; do not mix the two methods when computing a later delta.

## Per-directory count invariants

Grouped JSON file results by the **exact parent directory**, relative to the repository root. No descendant directories are included. These are all discovered files in each target directory, not a claim that every file is micro or mergeable. Preserve total tests and the pass/skip breakdown after any later layout change.

| Directory under `src/__tests__/`               | Files   | Tests    | Passed   | Failed | Skipped |
| ---------------------------------------------- | ------- | -------- | -------- | ------ | ------- |
| `renderer/hooks/ui`                            | 22      | 182      | 182      | 0      | 0       |
| `renderer/components/FilePreview/markdownFast` | 14      | 229      | 229      | 0      | 0       |
| `renderer/hooks/agent/internal`                | 15      | 152      | 152      | 0      | 0       |
| `renderer/hooks/batch`                         | 21      | 273      | 273      | 0      | 0       |
| `renderer/hooks/cue`                           | 16      | 273      | 273      | 0      | 0       |
| `renderer/hooks/tabs/internal`                 | 10      | 102      | 102      | 0      | 0       |
| `renderer/hooks/remote`                        | 9       | 86       | 86       | 0      | 0       |
| `renderer/hooks/utils`                         | 9       | 183      | 183      | 0      | 0       |
| `renderer/components/DocumentGraph`            | 22      | 775      | 775      | 0      | 0       |
| `main/cue/triggers`                            | 9       | 88       | 88       | 0      | 0       |
| `main/stores`                                  | 15      | 241      | 241      | 0      | 0       |
| `main/coworking`                               | 12      | 125      | 125      | 0      | 0       |
| `main/storage`                                 | 12      | 212      | 212      | 0      | 0       |
| `main/stats`                                   | 18      | 420      | 420      | 0      | 0       |
| `main/agents`                                  | 26      | 781      | 778      | 0      | 3       |
| `main`                                         | 32      | 956      | 955      | 0      | 1       |
| `main/ipc/handlers`                            | 38      | 1996     | 1996     | 0      | 0       |
| `shared/pianola`                               | 16      | 374      | 374      | 0      | 0       |
| `cli/services`                                 | 16      | 507      | 506      | 0      | 1       |
| `maestro-p`                                    | 15      | 327      | 327      | 0      | 0       |
| **Total**                                      | **347** | **8282** | **8277** | **0**  | **5**   |

Project membership remains governed by `vitest.config.mts`: notably, `main/stats/integration.test.ts` belongs to jsdom despite its node-directory location. Do not move it across projects during merging.

## Known failure and rollout constraints

The sole failed assertion in the JSON profile is:

- File: `src/__tests__/main/web-server/routes/fileRoutes.test.ts:122`.
- Test: `explicit host file transfer > does not overwrite a preexisting attachment file symlink`.
- Error: `EPERM: operation not permitted, symlink`, at `fs.symlink` fixture creation.

This matches the preceding playbook's documented Windows symlink privilege limitation. It was not skipped, suppressed, or changed. Restoring the ability to create file symlinks requires an authorized human environment change; no such change was attempted. Captured stderr is retained, including mock diagnostics; the recorded assertion totals do not imply warning-free execution.

The preceding `04 - Final Verification and Measurement` verdict recommends **no further rollout**, using a corrected jsdom floor cost of 0.83–1.23s and node floor cost of 0.036–0.074s. This Stage 0 capture does not reverse that verdict. Later stages must account for it, the non-green baseline, and measured directory counts rather than treating the template's 338-file estimate as the observed state.
