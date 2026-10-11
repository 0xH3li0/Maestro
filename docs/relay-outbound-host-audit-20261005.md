# Relay outbound host audit (2026-10-05)

Historical audit: installed versions, pending permissions and service state
below describe the dated observations, not the current PR acceptance state.
For the rc integration and bounded startup contract, see
[Relay host contract](relay-host-contract.md) and
[startup incident follow-up](relay-auth-startup-incident-20261009.md).

This audit covers the host source in this checkout and a read-only check of the
installed Relay. It does not activate a plugin, send a Discord message, change
external automation or user services, or package/install a host build.

## Provisioning and identity

| Run                                                                                | Host path                                                                                                                         | Verified Relay tool access                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Codex desktop turn                                                           | `src/main/ipc/handlers/process/handle-spawn.ts` → `buildMcpInjection`                                                             | When plugins are enabled and tools are active, the host issues a proof for a stored agent and injects `mcp_servers.maestro` before the Codex `exec` arguments. Proof is revoked on exit.     |
| Local Codex Cue **agent prompt**                                                   | `src/main/cue/cue-spawn-builder.ts` → `buildMcpInjection`                                                                         | The host issues a proof for the Cue session's configured agent and revokes it in `cue-executor.ts`. The run has its own provider session.                                                    |
| Desktop-backed headless `maestro-cli send`                                         | `src/cli/commands/send.ts` → authenticated loopback `plugins_send_agent` → `plugin-headless-agent-runner.ts` → `agent-spawner.ts` | The host resolves the stored target agent, issues its run proof and injects Codex MCP config. The caller receives the provider result on CLI stdout; no desktop tab or callback is required. |
| Standalone CLI fallback, SSH, unverified providers, Claude interactive `maestro-p` | No supported local proof-backed bridge                                                                                            | Do not use for identity-sensitive Relay sends.                                                                                                                                               |
| Cue `action: command`, `command.mode: shell`                                       | `src/main/cue/cue-shell-executor.ts`                                                                                              | A shell command has no model MCP bridge or verified agent identity, even if its subscription has `agent_id`. It must pass its report to a supported agent run.                               |

The MCP bridge passes its proof outside tool arguments. `plugins_call_tool` in
`src/main/web-server/handlers/messageHandlers/plugins.ts` resolves the proof and
passes `callerAgentId` to the plugin. The Relay sender rejects a null identity
and checks the bound channel/thread or an explicit Pianola grant. Neither
`--tab` nor `args.agentId` establishes identity. A successful provider final
answer, dispatch acknowledgement, or desktop callback is not a Discord receipt.

## Supported return flow

For delegated results, return the worker's result to the **originating Codex** run (`<origin-agent-id>`). That run calls the
currently advertised Relay MCP tool with the report text and an existing
permitted destination. It returns the real tool result, including nonempty
`messageIds`, to its caller. A headless origin can receive the result through
the synchronous `maestro-cli send` response; it has no desktop callback tab.
Do not lend a run proof to a worker or put an originator ID in tool arguments.

For scheduled shell reports, keep the script's status and report text
deterministic. A downstream Cue `agent.completed` subscription can select the
specific shell subscription using `source_session_ids` and `source_sub`, and
pass `{{CUE_SOURCE_STATUS}}` / `{{CUE_SOURCE_OUTPUT}}` to the designated Codex
**agent prompt**. The shell step itself cannot call Relay. A manual shell
orchestrator can instead call `maestro-cli send` for the same stored origin
Codex agent and inspect its JSON response. In both cases the agent must call
the live advertised plugin tool, and the caller must require actual returned
`messageIds`. If the tool is absent or rejects the destination, report failure;
do not infer delivery from prose.

The source now supports:

```bash
maestro-cli send <origin-agent> <prompt> --require-tool-receipt sh.maestro.relay/send
```

This implies
`--require-plugin-tools`, names the exact host tool contribution, and requires
a successful call observed on that run's proof. The CLI JSON adds
`toolReceipts: [{ runId, agentId, toolId, messageIds }]`. A zero exit status
requires a successful provider run, the requested tool still active, and a
matching receipt with nonempty numeric Discord IDs. Final provider prose is
never parsed as a receipt. The random `runId` is separate from the secret
proof. A nonzero result may still carry IDs from a completed send before a
later provider failure, so a caller must inspect them before retrying.

For a deterministic consumer, pass the full stored origin agent ID, capture
stdout as JSON, and require process exit 0 plus `success: true`. Check top-level
`agentId` is the origin, then select a `toolReceipts` entry whose `agentId`
equals that origin, `toolId` equals `sh.maestro.relay/send`, `runId` is a
32-character lowercase hex string, and `messageIds` is a nonempty array of
Discord numeric ID strings. Store those IDs with the report's own key before
marking it delivered. `sh_maestro_relay__send` is the MCP callable name to
discover inside the agent run; `sh.maestro.relay/send` is the host contribution
ID passed to this CLI guard. On a nonzero exit, inspect any receipts before
deciding whether retrying could duplicate a completed send.

`--require-plugin-tools` remains available as the less specific guard: it
refuses the standalone fallback but does not prove a Relay send. The installed
CLI has neither source option until a separately authorized, packaged host
update. The integration consumer can draft script migration against this contract now, but
must not execute it against the installed CLI.

## Historical activation and migration limits

The dated read-only audit did not establish live delivery. Plugin trust,
enablement, granted Dispatch destinations and the separate Unattended choice
must be verified for the agreed integration build before use. Changed plugin
bytes require the operator's protected permission review; do not broaden grants
or infer tool availability from an old manifest name.

External report scripts and automation need their own authorized migration.
Preserve schedules and notification conditions, and use proof-backed agent
runs instead of a legacy HTTP sender. This source audit does not authorize
external file edits, service retirement, installation or provider authentication.

The private deployment inventory, agent identifiers and machine-specific service
and authentication state are intentionally omitted. They do not define the host
contract or the current PR acceptance state.

## Source verification

Focused Vitest suites for CLI send, Cue spawn, headless runner, run identity
and WebSocket plugin handlers passed. CLI and main TypeScript no-emit checks
passed. The receipt tests cover exact proof/agent/tool correlation, unrelated
and malformed results, model-only IDs, risk-blocked and rejected calls,
deactivation, expiry, and provider failure. These are source tests, not a
live Discord delivery test.

## Historical diagnostic lessons

Host-side MCP initialization and `tools/list` can advertise a Relay tool while
a particular provider turn lacks it. Provider authentication, ephemeral MCP
configuration and the model's tool catalog are distinct checks. A provider's
final prose does not establish that its tool ran or that a destination accepted
a message.

A receipt-required run must preserve an earlier provider error when no receipt
arrives, while still returning `success: false`. The source regression covers
this error-reporting rule; it does not establish live delivery or change the
provider's authentication state.

Any separately authorized live acceptance should begin with a no-send tool
catalog diagnostic for the chosen originator. Inspect effective spawn arguments
and MCP startup diagnostics if the tool is missing. Only after tool presence and
destination binding are verified should the operator authorize controlled
delivery. Require a host-observed receipt with nonempty `messageIds`; do not
infer delivery from provider prose or retry potentially delivered work blindly.
