---
type: report
title: Vitest Tier A Directory Record and Calibration
created: 2026-10-16
tags:
  - vitest
  - performance
  - test-consolidation
related:
  - '[[vitest-tier-a-before-state-2026-10-15]]'
  - '[[vitest-tier-a-jsdom-merges-2026-10-16]]'
  - '[[vitest-tier-a-node-merges-2026-10-16]]'
  - '[[vitest-tier-a-verification-2026-10-16]]'
  - '[[01 - Tier A Small-Average Directories]]'
  - '[[02 - Tier B Fat-Average jsdom Directories]]'
---

# Tier A directory record and calibration

**Tier B is not justified by the measured timing results.** Tier A removed 192 file floors while preserving all assertion names and statuses, but the measured modeled phases increased by 100.47 aggregate worker-seconds. The signed observed savings per floor are **-0.9366s for jsdom** and **-0.09234s for node**. These are before/after deltas, not causal estimates of file-startup cost.

## Per-directory record

Directory paths are relative to `src/__tests__/`. Counts include all files in the exact parent directory, not only micro/mergeable files, and include skipped assertions. This follows the original main playbook document 02's six-column record schema. The nine jsdom stages precede eleven node stages; the historical checkbox labels do not define the actual stage numbers.

Stage wall is the successful directory-run wall recorded in the jsdom/node merge reports, not merge labor time or a full-suite checkpoint wall. Directory invocations may include descendants; those extra assertions are excluded from the exact-parent counts below. Conflict entries report observed isolation boundaries rather than inventing an unmeasured pairwise-conflict count.

| Directory                                      | Before (files/tests) | After (files/tests) | Mock conflicts                                                                                  | Stage wall | Notes                                                                                                                |
| ---------------------------------------------- | -------------------- | ------------------- | ----------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `renderer/hooks/ui`                            | 22 / 182             | 3 / 182             | `runtimeContext` false/true factories separated                                                 | 6.83s      | Stage 1; 19 floors removed; original hooks scoped to their suites.                                                   |
| `renderer/components/FilePreview/markdownFast` | 14 / 229             | 2 / 229             | No same-module factory conflict                                                                 | 1.73s      | Stage 2; 12 floors removed; rendering and pipeline domains separated.                                                |
| `renderer/hooks/agent/internal`                | 15 / 152             | 4 / 152             | Ownership `windowContext` contaminated tool capture; original suite isolated                    | 3.73s      | Stage 3; 11 floors removed; directory run includes 80 descendant assertions.                                         |
| `renderer/hooks/batch`                         | 21 / 273             | 6 / 273             | Remote mock intercepted real kill/document/worktree hooks; originals isolated                   | 10.43s     | Stage 4; 15 floors removed; 1,760-line worktree suite retained; 21 descendant assertions.                            |
| `renderer/hooks/cue`                           | 16 / 273             | 7 / 273             | Viewport mock replaced real layout; persistence/selection/state factories isolated              | 2.29s      | Stage 5; 9 floors removed; original conflicting suites retained.                                                     |
| `renderer/hooks/tabs/internal`                 | 10 / 102             | 2 / 102             | No observed mock-conflict failure                                                               | 2.60s      | Stage 6; 8 floors removed; helper and handler domains separated.                                                     |
| `renderer/hooks/remote`                        | 9 / 86               | 3 / 86              | Goal-run settings/selector and group store/ID factories isolated                                | 10.04s     | Stage 7; 6 floors removed; identical capture-free listener factories shared.                                         |
| `renderer/hooks/utils`                         | 9 / 183              | 2 / 183             | No reported factory conflict                                                                    | 2.62s      | Stage 8; 7 floors removed; 2,753-line persistence suite retained.                                                    |
| `renderer/components/DocumentGraph`            | 22 / 775             | 11 / 775            | Screenshot `graphDataBuilder` factory separated from real data                                  | 10.17s     | Stage 9; 11 floors removed; oversized/layout and documentation-only fixtures retained.                               |
| `main/cue/triggers`                            | 9 / 88               | 2 / 88              | Competing provider factories separated                                                          | 0.450s     | Stage 10; 7 floors removed; temporal/registry and provider-wrapper clusters.                                         |
| `main/stores`                                  | 15 / 241             | 7 / 241             | Fake-timer Claude-usage/deferred-write conflict; original suites restored                       | 2.57s      | Stage 11; 8 floors removed; captured Electron-store constructors isolated; 21 descendant assertions.                 |
| `main/coworking`                               | 12 / 125             | 4 / 125             | Browser-bridge and socket-path Electron factories separated                                     | 0.357s     | Stage 12; 8 floors removed; capture-free bridge/audit factories shared; 17 descendant assertions.                    |
| `main/storage`                                 | 12 / 212             | 8 / 212             | Claude filesystem mock replaced real image writes; original suites restored                     | 0.596s     | Stage 13; 4 floors removed; filesystem, Electron and remote-storage factories separated.                             |
| `main/stats`                                   | 18 / 420             | 12 / 420            | SQLite, readonly-query and environment-migration fixtures isolated                              | 1.80s      | Stage 14; 6 floors removed; integration suite remains jsdom; 38 descendant assertions.                               |
| `main/agents`                                  | 26 / 781             | 11 / 781            | Usage/startup factories separated; detection/path/provider conflicts isolated                   | 7.51s      | Stage 15; 15 floors removed; 778 passed / 3 skipped; oversized storage suite retained.                               |
| `main`                                         | 32 / 956             | 21 / 956            | Discovery/lifecycle/configuration/watcher/integration/remote factories split                    | 24.99s     | Stage 16; 11 floors removed; 955 passed / 1 skipped; completed recursive receipt has 11,735 assertions in 397 files. |
| `main/ipc/handlers`                            | 38 / 1996            | 33 / 1996           | Only compatible clusters merged; conflicting factories retained                                 | 3.66s      | Stage 17; 5 floors removed; duplicate Mock import corrected; 11 descendant assertions.                               |
| `shared/pianola`                               | 16 / 374             | 3 / 374             | Domain factories separated; suite-level lifecycle scopes retained                               | 0.446s     | Stage 18; 13 floors removed; classification/storage, orchestration/policy and task/watcher domains.                  |
| `cli/services`                                 | 16 / 507             | 11 / 507            | Real run-storage separated from filesystem mocks; batch/prompt/storage/spawn conflicts isolated | 1.29s      | Stage 19; 5 floors removed; 506 passed / 1 skipped.                                                                  |
| `maestro-p`                                    | 15 / 327             | 3 / 327             | Distinct PTY factories separated                                                                | 0.675s     | Stage 20; 12 floors removed; parsing/CLI, driver/prompts and streaming/session domains.                              |

Totals: **347 -> 155 exact-parent files**, **8,282 assertions unchanged (8,277 passed / five skipped)**. Jsdom targets: **138 -> 40 files**, 98 floors removed, 2,255 assertions. Node-directory targets: **209 -> 115 files**, 94 floors removed, 6,027 assertions. `main/stats/integration.test.ts` remains jsdom; all removed floors in the latter group are node files. Global suite: **1,706 -> 1,514 files**, all **45,643 assertion names/statuses unchanged** against the approved filtered pre-merge baseline.

## Calibration

Use signed savings: `(before modeled phase sum - after modeled phase sum) / actual file floors removed`. Do not divide by the estimated 220 floors, by tests, or by all retained files. Model jsdom as environment plus import; model node as import only, matching the playbook. Other worker phases and node environment are not included.

| Project | Modeled phases before      | Modeled phases after       | Floors removed | Aggregate seconds saved | Seconds saved per floor | Original model                  |
| ------- | -------------------------- | -------------------------- | -------------- | ----------------------- | ----------------------- | ------------------------------- |
| jsdom   | 642.34 + 851.65 = 1493.99s | 649.33 + 936.45 = 1585.78s | 98             | -91.79s                 | **-0.9366s**            | +1.0s                           |
| node    | 70.76s                     | 79.44s                     | 94             | -8.68s                  | **-0.09234s**           | +0.07s                          |
| Total   | 1564.75s                   | 1665.22s                   | 192            | **-100.47s**            | Not pooled for Tier B   | +104.58s at actual floor counts |

Positive values would mean savings. Negative observations must not be clamped to zero or presented as a speedup. The original model predicted 98 x 1.0 + 94 x 0.07 = **104.58s** aggregate savings for the actual removed floors; it did not predict the observed increase.

The inputs are Stage 0 and final verification sequential split-project duration summaries. Stage 0's node run was unfiltered/non-green, while the after run used the approved newline-safe single-test exclusion and command-scoped `NODE_ENV=test`. The baseline also had two capability-driven skips that later passed. These are the existing same-method phase receipts, not a controlled identical-status A/B experiment. The approved filtered combined baseline does have identical assertion statuses, but its combined phases cannot supply separate project calibration. See [[vitest-tier-a-verification-2026-10-16]] for the full caveats and measured counts.

Combined after walls were **346.59s, 302.08s and 278.14s**, versus **281.87s** approved filtered pre-merge and **273.36s** original Stage 0. The 68.45s after-run spread and inconsistent wall shifts do not establish a stable speedup. No causal slowdown, host-contention cause, or precise future runtime is asserted.

## Tier B decision

**Do not start Tier B on the current performance justification.** Its nominal 219 jsdom-floor reduction at the original +1.0s model promised **219s aggregate / 27.375s idealized wall at eight workers**. Substituting the observed jsdom coefficient gives **219 x -0.9366326531 = -205.12s aggregate savings**, or **-25.64s idealized wall savings**. This is a conditional model calculation, not a reliable slowdown prediction; aggregate worker time divided by eight is not measured elapsed time.

The corrected data provide **no demonstrated positive payoff**. Tier B also raises the merged-file cap to 3,000 lines and targets denser shared mocks; its source-size ceiling means 219 floors is only an estimate and requires a new feasibility count. Neither fewer files alone nor the earlier main-playbook calibration overrides the current failed timing premise. No Tier B merges, feasibility run, or source-size recount was performed in this task.

The Tier B document now carries a human gate before its first task. A conductor must explicitly approve proceeding despite the unvalidated performance benefit, or decide not to pursue Tier B. Until then all its task boxes remain unchecked. The gate pauses that document; it is not a global halt marker. This is a completed Tier A calibration with a negative rollout decision, not a claim that Tier B was re-justified positively.

## Verification and evidence

Recomputed project phases from the four raw duration summaries and removed-floor denominators from the approved-before and final JSON file results. A temporary Node audit exited 0, checked all twenty exact-parent rows against the previous verification audit, compared all 45,643 assertion-name/status multiset entries including duplicate multiplicities, and verified the 98/94/192 floor totals. Skipped assertions remain part of every count.

Receipts in the shared playbook `Working/` folder:

- `vt-fu-a-calibration-audit.json`: recomputed rows, signed coefficients, Tier B arithmetic and global assertion comparison.
- `vt-fu-resume-approved-a-verified-2026-10-16.json` and `vt-fu-a-verification-profile.json`: assertion/count inputs.
- `vt-fu-before-a-jsdom.log`, `vt-fu-before-a-node.log`, `vt-fu-a-verification-jsdom.log` and `vt-fu-a-verification-node.log`: same-method phase inputs.
- `vt-fu-a-stage1.json` through `vt-fu-a-stage9.json`: jsdom stage receipts. The node report records its completed per-stage receipts and isolation findings.

Stage walls and conflict descriptions come from [[vitest-tier-a-jsdom-merges-2026-10-16]] and [[vitest-tier-a-node-merges-2026-10-16]]; no failed trial or partial timeout is counted as a successful stage. The external Tier A table is a snapshot of this canonical tracked report. No application source, tests, shared Vitest configuration, hooks, timeouts or exclusions changed. No task images were supplied or analyzed. No permanent test or application/UI smoke run is relevant to this documentation-only calculation.
