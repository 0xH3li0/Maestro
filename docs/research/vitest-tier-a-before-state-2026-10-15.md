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

## Authorized resume gate (2026-10-16)

The followup playbook now authorizes excluding only `explicit host file transfer > does not overwrite a preexisting attachment file symlink` for this Auto Run. The permission-restoration requirement above is historical, not a prerequisite for the filtered gate. The test source, shared Vitest configuration, repository push hooks, and machine permissions remain unchanged.

The first filtered invocation inherited `NODE_ENV=production` from the runner and exited 1. Its log contains `act(...) is not supported in production builds of React`, module-load failures, and mock failures. That invocation is not a valid test-environment baseline. Evidence: `C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working/vt-fu-resume-filtered-a-2026-10-16.log`.

With command-scoped `NODE_ENV=test`, a focused filtered run of `renderer/hooks/usePluginContributions.test.tsx` and `renderer/focusRingCss.test.ts` passed all five tests (2.66s command wall). Use this environment for subsequent playbook Vitest invocations; do not change shared configuration or broaden the exclusion.

```bash
NODE_ENV=test npx vitest run --config vitest.config.mts --testNamePattern "^(?!.*does not overwrite a preexisting attachment file symlink).*$"
```

### Observed result and unresolved acceptance mismatch

The corrected-environment filtered run exited 0: **1705 passed / 1 skipped files (1706); 45523 passed / 0 failed / 120 skipped tests (45643); 296.09s Vitest wall**. Log: `C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working/vt-fu-resume-filtered-a-test-env-2026-10-16.log`, lines 2067-2070. A second filtered full-suite invocation with default and JSON reporters also exited 0 with the same assertion counts (291.08s command wall). These are passing filtered runs, not unfiltered full-suite coverage and not the requested 45522/0/121 gate.

Assertion-level comparison against Stage 0 found exactly four status changes:

| Test                                                                                   | Stage 0 | Filtered profile | Explanation                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileRoutes.test.ts`: `does not overwrite a preexisting attachment file symlink`       | failed  | skipped          | Authorized exclusion.                                                                                                                       |
| `main/lite/lite.test.ts`: SSH-host rejection case with input `host\nother`             | passed  | skipped          | The supplied regex ends with `.*$`; JavaScript dot does not match the newline in the test name. This is an unintended additional exclusion. |
| `messageHandlers.test.ts`: `should allow a real subdirectory of the session root`      | skipped | passed           | Existing `describe.skipIf(!canSymlink())` capability probe now succeeds.                                                                    |
| `messageHandlers.test.ts`: `should reject a symlink pointing outside the session root` | skipped | passed           | Same capability-gated group. No permission change was performed by this run.                                                                |

A focused JSON run of `fileRoutes.test.ts` confirmed 20 passed / 1 skipped / 0 failed, with the named symlink test as its only skipped assertion. All 20 exact-directory file/test/pass/skip invariants remain identical to Stage 0. No directory merges were started.

The resume checkbox remains unchecked. Human approval is needed to replace the supplied pattern with the newline-safe equivalent `^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$` and accept the capability-driven baseline change. With those two formerly skipped tests passing, the expected breakdown would be **45524 passed / 0 failed / 119 skipped** out of the unchanged 45643 tests; that corrected-pattern full-suite result has not been run. Do not force additional skips to reproduce historical counts.

Profile: `C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working/vt-fu-resume-filtered-a-test-env-2026-10-16.json`; SHA-256 `36f331bef0503b7d7f454267525b6f1c870923da7aebafce8fda57d60c6a7f77`. Companion log: `vt-fu-resume-filtered-a-profile-2026-10-16.log`. Focused assertion evidence: `vt-fu-resume-file-routes-2026-10-16.json` in the same Working directory.

### Approved newline-safe resume gate

The human approval checkbox in [[01 - Tier A Small-Average Directories]] is now checked, approving the newline-safe filter and capability-driven count changes described above. This approval supersedes the historical pattern/count mismatch, not the single-test-only exclusion boundary.

Ran the following with command-scoped `NODE_ENV=test`, invoking the installed Vitest entry point directly with an argument array:

```bash
NODE_ENV=test node node_modules/vitest/vitest.mjs run --config vitest.config.mts --testNamePattern '^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$' --reporter=default --reporter=json --outputFile='C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working/vt-fu-resume-approved-a-verified-2026-10-16.json'
```

| Result                          | Observed                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| Exit                            | 0                                                                         |
| Files passed / failed / skipped | 1705 / 0 / 1 (1706 total)                                                 |
| Tests passed / failed / skipped | 45524 / 0 / 119 (45643 total)                                             |
| Vitest wall                     | 281.87s                                                                   |
| Command wall                    | 283.165s                                                                  |
| Exact-directory invariants      | All 20 unchanged: 347 files, 8282 tests, 8277 passed, 0 failed, 5 skipped |

Compared every file and ordered assertion name/status against the original Stage 0 JSON profile. No file, assertion-count, or assertion-name changes were found. Exactly three statuses changed:

- The authorized `fileRoutes.test.ts` symlink assertion changed from failed to skipped.
- The two existing capability-gated `messageHandlers.test.ts` assertions listed above changed from skipped to passed.

Applying the approved regex to all 45643 recorded assertion names excludes exactly the authorized symlink assertion. The SSH-host assertion containing `host\nother` ran and passed. The two newly available capability-gated assertions account for the revised pass/skip baseline; no additional test was excluded to force historical counts.

Evidence in `C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working`:

- `vt-fu-resume-approved-a-verified-2026-10-16.log`, summary lines 73792-73797.
- `vt-fu-resume-approved-a-verified-2026-10-16.json`, SHA-256 `dbf630c2d97478735919c4f76355e5ae8210032045c1319d780e53c83dc69dd8`.

An earlier capture, `vt-fu-resume-approved-a-2026-10-16.log` / `.json`, is invalid: shell command substitution corrupted the regex argument and all 45643 tests were skipped despite exit 0. It is retained only as rejected execution evidence, not a passing baseline. The verified invocation above used shell-safe quoting and printed its exact argument array before execution.

The resume gate is satisfied with the approved counts and filter. Use this newline-safe filter and command-scoped `NODE_ENV=test` for subsequent playbook Vitest invocations; repository push hooks remain unchanged and unfiltered. No application code, tests, shared configuration, hooks, or machine permissions changed. No directory merges were started; the next checkbox belongs to a later task instance.
