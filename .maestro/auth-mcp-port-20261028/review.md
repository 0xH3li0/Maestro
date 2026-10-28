---
type: report
title: Independent auth and MCP supervision review
created: 2026-10-28
tags:
  - maestro
  - code-review
  - process-supervision
related:
  - '[[PLAN]]'
  - '[[checks]]'
  - '[[consumers]]'
---

## Review identity and scope

Reviewed the complete diff from pinned rc `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06` through implementation HEAD `5a4356166319ef60c3d24e6ccd2ec07ae8a8d55a` (tree `15d459810d5ddcc4b5828bf19571dfcdcf3f474c`), then independently re-reviewed the three-file correction below. Final reviewed `src` subtree: `47a5dec601c17dad3dcfbde85cae97bd603aaeff`. The review commit contains this exact source tree; using a source subtree avoids a circular hash of the report itself. Delivery must refresh review evidence if its source tree or upstream basis changes.

Used `mattpocock-skills:code-review` with independent ephemeral Standards and Spec reviewers, as expressly authorized by REVIEW. Neither reviewer implemented the original changes. Both reviewed the complete pinned diff and then the correction. No persistent Maestro agents were created. Standards sources: AGENTS/CLAUDE, CONTRIBUTING, CLAUDE-PATTERNS, PROCESS-SYSTEM, AGENT-INFRA, TEST-PATTERNS. Spec: [[PLAN]] and the original playbook. The pinned source patch and all prior implementation/check notes were inspected. No images accompanied the task (zero analyzed).

## Standards

Initial and final Standards reports: **0 hard violations, 0 actionable smell findings**. Shared supervisor relocation preserves upstream behavior; CLI re-export maintains existing imports. Desktop composes canonical termination and parsed-event routing. Consult cleanup follows CONTRIBUTING's listener cleanup rule. The correction below uses the captured predecessor and canonical `stopProcess`, without another kill ladder or targeting a successor by session ID. Test cleanup owns both processes.

## Spec

Initial Spec report: **1 P1 finding**, no scope creep. Original `ChildProcessSpawner.ts:692-694` disposed supervision on replacement while its stop ladder could still be pending. Spec requires “sauberes Aufräumen/Beendigung” and preserving “termination ownership.” A timed-out provider ignoring SIGTERM, followed by ProcessManager.kill removing its map entry and immediate replacement, lost its pending SIGKILL because supervision disposal cancelled the shared StopHandle.

**Disposition: fixed.** `src/main/process-manager/spawners/ChildProcessSpawner.ts:695` now finishes canonical immediate termination of an already-failed captured predecessor before disposing supervision. A healthy predecessor keeps the existing lifecycle. The successor cannot be selected accidentally through the session map.

Regression at `src/__tests__/main/process-manager/spawners/ChildProcessSpawner.auth-lifecycle.test.ts:40` uses the fixture's new SIGTERM-resistant phase, waits for timeout, reuses the shared stop ladder as ProcessManager.kill does, removes the map entry, and registers a successor. It requires predecessor SIGKILL and successor survival. Before the fix it failed with signalCode null (review-regression-red.log). After the fix it passes. Both independent reviewers re-read the correction and closed the finding. Final Spec report: **0 open relevant findings**; existing supervisor tests cover extended genuine semantic progress.

## Verification and limits

- Initial additional desktop/StdoutHandler check: 2 suites, 176 tests passed (`check-logs/review-desktop.log`).
- Final eight focused suites: **485 tests passed**, exit 0 (`check-logs/review-regression-green.log`; exact command in [[checks.json]]). Includes all earlier six suites plus desktop spawner and StdoutHandler regressions.
- Scoped Prettier check passed. Scoped ESLint exited 0; repository configuration ignores test/fixture files, which is explicitly recorded rather than claiming they were linted.
- `git diff --check upstream/rc` passed; full product diff remains the six implementation files and five regression/fixture files. No unrelated product changes.
- Prior main/CLI typecheck evidence remains blocked by missing shared papaparse/parsimmon/luxon dependencies/types; no clean full typecheck claimed. Shared dependencies were read only via a temporary local symlink, removed after hooks/checks.
- Full suite and validate:push omitted by instruction. No live credentials/providers/MCP, installation, restart, deployment or merge.
- Native parent launch: `/proc/232449` in this cwd, `gpt-6.1-sol`, `model_reasoning_effort="medium"`. Reviewers inherited the parent model; no model override or Astra launch requested.

## Task boundary and handoff

REVIEW alone is completed. DELIVERY remains unchecked and owns fresh rc comparison, upstream PR creation, review comments and final CI acceptance. Commit this review correction and artifacts, push only this fix branch to origin with the existing invocation-scoped guard-preserving procedure. Original hook files and config remain unchanged. Final open findings: Standards 0, Spec 0.

## DELIVERY independent refresh

Published implementation head `a396cb466d7bba992a204cc380a95d85f6a8d079` was independently reviewed again by ephemeral Standards and Spec reviewers using the same two-axis skill. Both reported zero open findings on subtree `47a5dec601c17dad3dcfbde85cae97bd603aaeff`.

Greptile then reported P1 [timeouts discard partial answers](https://github.com/RunMaestro/Maestro/pull/1944#discussion_r4405363137). **Valid and fixed:** the timeout callback marked `resultEmitted` before flushing `streamedText`. Desktop consult therefore received an empty partial answer. Replaced the direct emission with existing `emitAgentErrorAfterOutput` and `flushStreamedText: true`, preserving data-before-error ordering and canonical emission bookkeeping.

The real desktop lifecycle regression now also connects `createDesktopConsultRunner`, preserving partial `Starting work` for post-model/MCP stalls while retaining the error and failed exit. Before the correction it failed with empty text (`delivery-partial-red.log`); after correction all eight suites and 485 tests passed (`delivery-partial-green.log`). Both independent reviewers separately re-read this correction and canonical helper/exit handling, accepted it, and reported zero new Standards/Spec findings. No independent reviewer edited code.

The delivery commit records the final source subtree below. Its metadata cannot contain its own commit hash; resolve the exact published delivery head with `git rev-parse HEAD` and compare it to GitHub `headRefOid`. Source subtree identity binds the review across evidence-only changes. Final CI and full comment/thread readback are completion gates after publication, not inferred from an earlier head.

Final independently reviewed source subtree: `c85f9c1dd0b6e66b98cc6c6a3caa1d315fc3a4b5`. Both reviewers accepted the partial-output correction before publication.

## Final published-head verification and late formatting review

Both independent reviewers verified published head `c1e62a750073f36f2cdd4f753c0d3844b3e3b11f` and exact source subtree `c85f9c1dd0b6e66b98cc6c6a3caa1d315fc3a4b5`: zero Standards/Spec findings. Greptile thread was answered with this SHA and red/green evidence, then resolved.

CodeRabbit's complete review body and both inline comments were read after its delayed publication. No outside-diff/nitpick findings appeared. It requested tab indentation in checks.json and check-logs/source-diff.json. checks.json was already formatted in c1e62a7500; source-diff.json is now formatted without changing its parsed JSON value. Both pass explicit Prettier checks. This follow-up is evidence-only: source tree remains identical to the independently reviewed published source. Final-head CI must still be observed after its push.

## Late-output drain correction

CodeRabbit [4405568024](https://github.com/RunMaestro/Maestro/pull/1944#discussion_r4405568024) found that the timeout error still preceded output written during SIGTERM. Valid, reproduced with a final unterminated JSON envelope: expected data,error, observed error,data (`delivery-drain-red.log`).

The callback now records the host failure without marking the result emitted. Canonical ExitHandler parses/drains the final envelope and flushes output. A temporary, generation-filtered prepended exit observer then emits the host error before consult exit observers. It removes itself before delivery and in finally, including failed/superseded exit handling. No ExitHandler contract or extra implementation file was changed. Forced completion follows the same path.

Regression covers both an initially empty answer and an already-present partial answer followed by final SIGTERM text, final failed consult result, data,error ordering, next-turn reuse and no remaining exit listeners. The resistant predecessor fixture now signals STOPPING when SIGTERM actually arrives, keeping the supersession race regression synchronized with pending termination. Canonical final-envelope behavior selects the final answer rather than concatenating earlier prose; the assertion uses Last answer in both cases.

Final eight focused suites: **487 tests passed**, exit 0 (`delivery-drain-green.log`). Scoped ESLint and Prettier pass. Both independent reviewers accepted this three-file correction, with zero open Standards/Spec findings. Final reviewed source subtree supersedes earlier trees: `6932c0aff9345a29cff19784dc882fd1cf09a4ff`. Exact published head is resolved from the commit containing this update, and final CI must be observed anew. Earlier Windows jobs remain superseded evidence, never final acceptance.
