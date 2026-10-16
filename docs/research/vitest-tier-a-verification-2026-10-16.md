---
type: report
title: Vitest Tier A Final Verification
created: 2026-10-16
tags:
  - vitest
  - performance
  - test-consolidation
related:
  - '[[vitest-tier-a-before-state-2026-10-15]]'
  - '[[vitest-tier-a-jsdom-merges-2026-10-16]]'
  - '[[vitest-tier-a-node-merges-2026-10-16]]'
  - '[[vitest-tier-a-checkpoints-2026-10-16]]'
  - '[[01 - Tier A Small-Average Directories]]'
---

# Tier A final verification

All requested correctness checks passed on source revision `dc5d142985`, branch `auto-run-release/lite-fixed-20261012-1014`. No source, tests, configuration, timeouts, or hooks changed in this verification task. **The expected aggregate timing reduction was not observed:** split-project environment/import sums increased by **100.47s**, rather than dropping by approximately 110-115s. This completes verification, not calibration or authorization to start Tier B.

## Method

All commands ran sequentially from the repository root with Node `v25.6.1`, the unchanged `vitest.config.mts`, fork workers, and `maxWorkers: 8`. Every playbook Vitest invocation used command-scoped `NODE_ENV=test` and the approved newline-safe single-test exclusion:

```text
--testNamePattern '^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$'
```

The two default-reporter full-suite runs were followed by a third full-suite run with default and JSON reporters. Additional jsdom and node project runs supplied separate phase sums, matching Stage 0's measurement method. JSON assertion results alone do not expose the environment/import phase breakdown. Split-project wall times must not be added and compared with combined-run wall times.

Captures use the permitted shared playbook folder, `C:/Users/Administrator/Software/Maestro/.maestro/playbooks/Working/`. Invocation shape:

```bash
NODE_ENV=test node node_modules/vitest/vitest.mjs run --config vitest.config.mts --testNamePattern '^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$'
# JSON profile: append --reporter=default --reporter=json --outputFile=<Working>/vt-fu-a-verification-profile.json
# Project diagnostics: append --project jsdom, then --project node in a separate invocation
```

This is filtered coverage, not unfiltered coverage. The original failing symlink fixture remains unchanged. Expected error-path diagnostics remain in the logs; passing assertions do not imply warning-free execution.

## Static checks

All checks exited 0 before suite measurement:

- ESLint with `-c eslint.dashes.config.mjs --no-ignore` over all twenty target directories. This uses the repository's existing test-tree configuration, which enforces the comment-dash rule; it is not a claim that normally disabled production ESLint rules were enabled for tests. Directory arguments are recorded in the manifest and static log. The `main` root argument also traverses descendants.
- All three configured TypeScript checks: `tsc -p tsconfig.lint.json`, `tsc -p tsconfig.main.json --noEmit`, and `tsc -p tsconfig.cli.json --noEmit`.
- Prettier `--check` over all **61** merged suites in the twenty exact-parent targets, including the `.test.tsx` clusters as well as `.test.ts` files.
- Every new merged suite remains below the 1,500-line cap. The largest is `shared/pianola/classification-and-storage.merged.test.ts`, with 1,425 newline-terminated lines.

Receipt: `vt-fu-a-verification-static.log`. Exact commands, target paths, exit statuses, and command walls: `vt-fu-a-verification-manifest.json`.

## Suite results

All five measured invocations exited 0. Walls below are Vitest's reported duration, not process-launch duration.

| Capture                   | Files passed / skipped | Tests passed / failed / skipped | Vitest wall |
| ------------------------- | ---------------------- | ------------------------------- | ----------- |
| Full-suite verification 1 | 1513 / 1 (1514 total)  | 45524 / 0 / 119 (45643 total)   | 346.59s     |
| Full-suite verification 2 | 1513 / 1 (1514 total)  | 45524 / 0 / 119 (45643 total)   | 302.08s     |
| Full-suite JSON profile   | 1513 / 1 (1514 total)  | 45524 / 0 / 119 (45643 total)   | 278.14s     |
| jsdom project             | 976 / 1 (977 total)    | 28004 / 0 / 108 (28112 total)   | 280.71s     |
| node project              | 537 / 0 (537 total)    | 17520 / 0 / 11 (17531 total)    | 34.63s      |

Compared the final JSON profile with the approved pre-merge receipt `vt-fu-resume-approved-a-verified-2026-10-16.json` as a sorted multiset of **all 45,643 assertion full names and statuses**, retaining duplicate-name multiplicities. They match exactly. All twenty exact-parent directories also retain their individual assertion-name/status multisets: **8,282 target assertions, 8,277 passed and five skipped**.

Full-suite file results decrease **1,706 to 1,514**, removing **192** file floors. Exact-parent target files decrease **347 to 155**: the nine jsdom directories remove 98 and the eleven node directories remove 94. Project totals decrease **1,075 to 977 jsdom files** and **631 to 537 node files**. `main/stats/integration.test.ts` remains in jsdom; no project membership changed. File counts come from JSON `testResults` or terminal file summaries, not the nested-suite `numTotalTestSuites` counter.

Profile SHA-256: `31aad05ad81c38dc510ec2e0979b49864beb0d2c47436b4fd679339ab4503878`.

## Phase sums and timing interpretation

Same-method comparison against Stage 0's sequential split-project runs:

| Aggregate worker phase              | Before       | After        | After minus before |
| ----------------------------------- | ------------ | ------------ | ------------------ |
| jsdom environment                   | 642.34s      | 649.33s      | +6.99s             |
| jsdom import                        | 851.65s      | 936.45s      | +84.80s            |
| node import                         | 70.76s       | 79.44s       | +8.68s             |
| **Sum of the three modeled phases** | **1564.75s** | **1665.22s** | **+100.47s**       |

The combined-run diagnostics are recorded separately; they are not substituted for split-project measurements:

| Combined capture             | Environment | Import   | Environment + import | Wall    |
| ---------------------------- | ----------- | -------- | -------------------- | ------- |
| Original Stage 0, unfiltered | 592.28s     | 855.48s  | 1447.76s             | 273.36s |
| Approved pre-merge, filtered | 589.53s     | 879.79s  | 1469.32s             | 281.87s |
| Verification 1, filtered     | 707.62s     | 1150.43s | 1858.05s             | 346.59s |
| Verification 2, filtered     | 612.22s     | 1000.55s | 1612.77s             | 302.08s |
| Final JSON profile, filtered | 564.60s     | 897.57s  | 1462.17s             | 278.14s |

The original Stage 0 suite failed the subsequently excluded symlink test and had two additional capability-driven skips; the approved filtered baseline has the same assertion statuses as the after profile. These differences remain explicit rather than presenting Stage 0 as a green, identical-coverage benchmark.

The two verification walls exceed both recorded pre-merge walls. The final JSON-profile wall is 4.78s above original Stage 0 and 3.73s below the approved filtered baseline. The three after combined runs span 68.45s. These observations do not demonstrate the projected speedup or establish a causal per-file cost. Resource contention or other host variability is a possible explanation, not a measured cause. No reruns were selected to manufacture a favorable result.

The next unchecked task owns the per-directory table, separate jsdom/node calibration, and any Tier B re-justification. Tier B has not started and remains unapproved by this report.

## Evidence and review

Artifacts in the shared Working folder:

- `vt-fu-a-verification-run1.log` and `vt-fu-a-verification-run2.log`.
- `vt-fu-a-verification-profile.log` and `vt-fu-a-verification-profile.json`.
- `vt-fu-a-verification-jsdom.log` and `vt-fu-a-verification-node.log`.
- `vt-fu-a-verification-static.log` and `vt-fu-a-verification-manifest.json`.
- `vt-fu-a-verification-audit.json`: assertion-preservation results, exact-parent counts, merged-file cap, baseline/after phase sums, profile checksum, and static-check receipts.

A temporary Node audit required all ten command exits to be zero, checked the terminal counts, compared complete assertion multisets globally and per directory, verified file counts and line caps, and recomputed phase sums from completed logs. It exited 0. Temporary execution/audit scripts were removed after use; raw receipts remain for the calibration task.

Review covered the approved exclusion, status/count invariants, exact-parent versus recursive scope, suite versus file counters, physical line counting, phase-method comparability, historical failed-baseline qualification, and the absence of an evidenced speedup. No blocking findings. Only this report and the external playbook completion record change; no application or API smoke run is relevant to this measurement-only task. The actual Vitest runs exercise the consolidated test-runner surface.
