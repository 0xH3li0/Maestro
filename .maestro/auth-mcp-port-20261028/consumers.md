---
type: report
title: Desktop and consult auth and MCP supervision consumers
created: 2026-10-28
tags:
  - maestro
  - process-supervision
  - auth
related:
  - '[[PLAN]]'
  - '[[core]]'
  - '[[AUTH-MCP-PORT-20261028-01]]'
---

## Scope and comparison

Implemented CONSUMERS only on core commit `080f10b0ba`, pinned base `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06`. Read [[PLAN]], [[core]] and `pins.json`; compared all three consumer changes against exact source `5d72b672fa7b9481087c112fc12166e8a17eb47d` before editing. Exactly the three authorized product files changed. No additional helper module or obsolete parser API was introduced. No images supplied or analyzed.

## Desktop contract

`src/main/process-manager/spawners/ChildProcessSpawner.ts` imports `superviseAgentProcess` from the shared control layer and the existing startup, idle/tool and lifetime defaults. Applies them only to Codex child turns receiving a prompt or prepared stdin. Promptless children with open stdin remain outside supervision; ProcessManager routes human PTYs to PtySpawner before this class and Codex app-server turns to their own spawner. No app-server or PTY policy changed.

The pinned source depended on removed `StdoutHandler.setParsedEventObserver`; current `parsedEvent.ts` is the compatible seam. A per-turn `parsed-event` listener filters the session id, captured spawn generation and ManagedProcess identity before calling shared `observe`. Existing stdout/stderr generation guards reject predecessor chunks before parsing. The supervisor handles semantic progress and finite MCP tool leases; arbitrary transport output does not reset the budgets.

A per-session disposer removes the predecessor listener and supervisor timers when this spawner registers a replacement, even when ProcessManager already removed the predecessor's process-map entry. Forced settlement releases the predecessor's continuation; its generation check suppresses all shared exit side effects and cleans its temporary files. Normal completion, failed spawn and forced completion also dispose the listener and timers. Identity-checked disposer deletion cannot remove a successor's registration.

On supervision stop, mark the turn failed, preserve one supervisor diagnostic, suppress result/error reclassification, and signal the captured remote PID file when present. The shared supervisor owns canonical `stopProcess` tree termination and bounded forced stream teardown. Race turn completion with forced stop, overriding exit code to 1 on supervision failure (including a launcher exiting zero). The existing generation-aware ExitHandler releases the actual turn and emits exit; the existing exception fallback remains intact. There is no extra kill ladder.

For supervised Codex only, the shared supervisor's exit-drain deadline replaces the separate `armStdioCloseWatchdog`; its stop callback also signals the remote. The original close watchdog and remote callback remain unchanged for other child turns. This avoids competing teardown deadlines. Local/SSH argument construction, stdin delivery and temporary-file management remain existing code paths.

## Consult contract

`src/main/cross-agent/consult-runner.ts` ports the pinned source change exactly: filter `agent-error` by process id, retain the first message with nullish assignment, forward it through ConsultEnd, and detach that listener with the existing listeners on exit, stop, unsuccessful spawn and thrown spawn. Partial stream text remains available.

`src/shared/maestro-lib/agents/consult.ts` adds optional `ConsultEnd.error`. A nonempty host error changes a nominal exit zero into failure and takes precedence in the displayed error. Nonzero/null exits retain their existing failure policy, partial text is retained, and failed consults omit the provider continuity id. Current rc's `consultExitError` fallback is preserved, including maestro-p untrusted workspace exit 7; the older source's inline fallback was deliberately not restored. Existing consult silence and total budgets are unchanged.

## Verification and handoff

Static source comparison, scoped Prettier formatting/checking and `git diff --check` only. Original pre-commit runs scoped Prettier and ESLint; successful commit is the evidence for that hook. No tests written or executed as expressly required by CONSUMERS. Runtime cleanup, successor isolation, promptless exclusion, failure-plus-zero-exit and consult listener paths need regression evidence in TESTS-A/B and CHECKS. No full suite, validate:push, live providers/MCP, credentials, installation, restart or deployment.

Native `/proc/218739/cmdline` with this exact cwd showed `/home/chris/.local/bin/codex`, `-m gpt-6.1-sol` and `model_reasoning_effort="medium"`. This proves actual Sol execution for this task; no Terra/Luna execution is claimed, and no Astra or subagent was launched.

Commit and push this bounded step only; the upstream PR remains assigned to DELIVERY after tests, checks and independent review. Preserve original pre-commit and pre-push files and core.hooksPath. Evaluate the original pre-push guard prefix against the exact branch/ref tuple, then use invocation-local hooksPath to skip only the prohibited full validation. Temporarily link existing shared dependencies read-only for pre-commit and remove the local link afterward; no shared dependency mutation.
