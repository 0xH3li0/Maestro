---
type: report
title: Shared auth and MCP supervision core port
created: 2026-10-28
tags:
  - maestro
  - process-supervision
  - auth
related:
  - '[[PLAN]]'
  - '[[AUTH-MCP-PORT-20261028-01]]'
---

## Implemented scope

CORE only, based on planning commit `ec9d4837e3e6b5094f312709d997c1e1bb1ca07e` and pinned rc `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06`. Read [[PLAN]] and `pins.json`; compared the three requested files with source `5d72b672fa7b9481087c112fc12166e8a17eb47d`. No cherry-pick of source history.

- Moved the current rc CLI supervisor to `src/shared/maestro-lib/control/agent-process-supervisor.ts`, with internal relative imports. Comparison of the implementation body after imports shows exactly one change: the startup diagnostic now mentions both `cli_auth_credentials_store=file` and `mcp_oauth_credentials_store=file` for a host already using file credentials. This is guidance only; the port does not read or change credentials/configuration.
- Replaced `src/cli/services/agent-process-supervisor.ts` with a compatibility re-export of **both** `superviseAgentProcess` and `assertHeadlessIdleProfile`. Existing CLI and plugin imports retain their contract.
- In `src/cli/services/agent-spawner.ts`, standalone Codex calls receive `HEADLESS_RUN_TIMEOUT_MS` and `HEADLESS_IDLE_PROFILE` when those options are absent. Defaults are applied before profile validation and before the shared preparation/effort-fallback deadline. Explicit non-nullish overrides remain unchanged, including invalid overrides that validation rejects. Other providers keep their existing policy.

## Retained lifecycle and limits

The shared implementation retains current rc's `processExited` promise (exit/close/failed-spawn evidence), defensive profile validation, signal/listener/timer disposal, hashed semantic progress, usage baselines, retry/replay rejection, independent anonymous/correlated tool allowances, `stopProcess` descendant cleanup and forced stream closure. No extra stop ladder was added.

Default Codex policy is startup 120 seconds, warning after 10 minutes without model progress, semantic idle 20 minutes, bounded opaque tool allowance 60 minutes and absolute ceiling 6 hours. Fresh semantic progress renews inactivity; transport chatter does not. Long productive work can exceed one hour. The absolute deadline still spans preparation and effort fallback, and `requireProcessExit` still retains caller authority until actual exit.

This step changes the noninteractive CLI Codex path and exposes the common implementation for later consumers. It adds no timers to PTYs or human login flows. Desktop/Consult wiring and runtime regression evidence belong to the following tasks; the complete port is not yet validated or ready for a PR.

## Verification and execution evidence

- `prettier --write` and `prettier --check` on exactly the three changed source files: exit 0, formatted.
- `git diff --check`: exit 0.
- Original pre-commit hook ran scoped Prettier and ESLint on the three source files: both passed. Cached lint-staged and shared executables were reused; the temporary local dependency link was removed.
- Static relocation comparison: implementation body differs only in the startup diagnostic; all new relative imports resolve to existing TypeScript files.
- No tests written or executed, as explicitly required by CORE. Type checking and focused regression execution remain assigned to CHECKS. No full suite or `validate:push`.
- Native process `/proc/215795/cmdline`, cwd this registered worktree, showed `codex exec ... -m gpt-6.1-sol -c model_reasoning_effort="medium"`. This proves this task's actual Sol launch; configured Terra/Luna tiers are not execution evidence. No Astra or additional agent launched. Zero images analyzed.

## Task delivery

Commit/push this bounded core step only. Preserve original pre-commit hooks and evaluate the original pre-push guard prefix against the exact branch/ref update, skipping only the forbidden full-suite portion through invocation-local hooksPath. No global or tracked hook/configuration changes. Read-only shared dependency reuse, with any temporary local dependency link removed after the hook; no shared package installation or mutation. The upstream PR remains assigned to DELIVERY after consumer wiring, tests, checks and independent review.
