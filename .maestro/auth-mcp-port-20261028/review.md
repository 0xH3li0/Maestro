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
