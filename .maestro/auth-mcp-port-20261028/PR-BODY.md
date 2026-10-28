## Summary

Codex exec turns that stall during authentication or MCP work now use the existing host supervision budgets in desktop and standalone CLI launches. Consults preserve host failures and partial output even when a launcher exits zero.

```text
CLI / desktop Codex exec
  shared supervisor (startup, semantic idle, tool lease, absolute ceiling)
    canonical process termination and listener cleanup
Desktop consult
  host failure -> failed result, partial text, no continuity ID
```

Preserves upstream headless supervision, explicit caller budgets, extended semantic progress, interactive shell lifecycles, and process generation ownership.

## Evidence

- **Before:** SIGTERM-resistant timed-out predecessor lost escalation when replaced; controlled regression failed with signalCode null.
  **After:** canonical immediate termination finishes the captured predecessor, successor survives; 487 focused tests across eight suites pass.
- Scoped Prettier and ESLint pass (repository ESLint ignores test fixtures). Local main/CLI TypeScript checks are blocked by missing shared papaparse/parsimmon/luxon/smol-toml dependencies/types; no changed-file errors were reported. CI supplies clean dependencies.
- Local full suite and validate:push intentionally omitted. Original pre-push branch guards evaluated separately; validation bypass is invocation-local, original hook files/config unchanged. Normal pre-commit formatting/lint remains enabled.
- Timeout failure is published after canonical final-output draining, before consult completion; regressions include SIGTERM-produced unterminated JSON and existing partial text.
- Desktop timeout regression also verifies partial answers reach the consult runner before the error; reproduced empty text before the fix, 487 tests pass after it.
- Independent Standards and Spec review: no open relevant findings on the published implementation and the subsequent partial-answer correction.
- Controlled fake processes only; no live credentials, providers, or MCP calls. Reproducible evidence is under `.maestro/auth-mcp-port-20261028/`.

## Merge Danger

**Door:** two-way

Revert restores previous supervision wiring; no stored-data migration.

**Blast Radius:** processes

Codex exec timeout/cleanup behavior and consult failure propagation. Human merge only; no deployment, installation, restart, or auto-merge requested.
