---
type: report
title: Auth and MCP supervision delivery PR 1944
created: 2026-10-28
tags:
  - maestro
  - delivery
  - process-supervision
related:
  - '[[PLAN]]'
  - '[[review]]'
  - '[[checks]]'
---

## Published change

Normal PR https://github.com/RunMaestro/Maestro/pull/1944 targets `RunMaestro/Maestro:rc` from `chr1syy:fix/auth-mcp-supervision-rc-20261028`. Fresh upstream fetch confirms basis `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06`; no rebase or extra source integration was necessary. Only six planned implementation files and five regression/fixture files differ under src. Existing upstream headless supervision is preserved.

Final source subtree `c85f9c1dd0b6e66b98cc6c6a3caa1d315fc3a4b5` is independently reviewed. The delivery head is the commit containing this report, obtained through `git rev-parse HEAD`; compare with PR `headRefOid`, then query all checks for that exact commit. This avoids a self-referential commit hash in its own content. Parent implementation head was `a396cb466d7bba992a204cc380a95d85f6a8d079`.

## Review disposition

Independent Standards: zero open findings. Independent Spec: zero open findings. Both reviewers repeated the published-head review and separately accepted the final two-file partial-output correction.

Greptile P1 https://github.com/RunMaestro/Maestro/pull/1944#discussion_r4405363137 was reproduced: desktop timeout returned empty text after a partial answer. The callback now reuses canonical `emitAgentErrorAfterOutput` with `flushStreamedText: true`. Real spawner-to-desktop-runner regression checks partial answer, failed exit and data-before-error order. Red then green logs are in [[checks.json]]. The bot thread is answered/resolved only after this fix is pushed. Human comments, review bodies, outside-diff/nitpick sections and all inline threads must be read again at the final head; no bot pass is described as human approval.

## Validation and CI evidence

Eight focused suites, 485 tests passed after the correction. Scoped Prettier and ESLint passed. Local main/CLI typechecks remain blocked by missing read-only shared papaparse/parsimmon/luxon/smol-toml dependencies/types; clean upstream CI lint/TypeScript passed at the initial product head. No shared dependencies were installed or modified. Local full suite and validate:push were intentionally omitted.

Exact-head live CI evidence: https://github.com/RunMaestro/Maestro/pull/1944/checks . Initial run: https://github.com/RunMaestro/Maestro/actions/runs/40757234743 . The initial run is not final-head acceptance. Auto Run checks DELIVERY only after all upstream checks on this delivery commit are successful, including both Linux and Windows test shards; no earlier-head pass substitutes for that. If a check fails, its concrete failure remains a blocker until corrected. The final chat handoff reports the resolved exact SHA and outcome.

## Publication and boundaries

Normal pre-commit hook runs. Push evaluates the original pre-push branch guard prefix against the exact origin fixbranch ref tuple, then skips only prohibited repo-wide validation via invocation-local core.hooksPath. Original hook files and repository/global configuration remain unchanged. Final verification compares local HEAD with the fork branch and requires no uncommitted tracked changes.

No merge, auto-merge, installation, restart, deployment, live credentials, provider, mail, Discord or MCP calls. Chris merges. No images analyzed. Native launch evidence: PID 237509, gpt-6.1-sol, medium effort.

## Late review readback

CodeRabbit published two minor artifact-formatting comments after the delivery push. checks.json was already corrected in c1e62a7500; source-diff.json was formatted subsequently, preserving parsed content. Both explicit Prettier checks pass. Original full review body, inline comments and thread replies were read; no human review or outside-diff/nitpick findings were present. These evidence-only changes preserve reviewed source subtree c85f9c1dd0b6e66b98cc6c6a3caa1d315fc3a4b5. Published product head c1e62a750073f36f2cdd4f753c0d3844b3e3b11f has final exact-head independent Standards and Spec confirmation.

## Late-output drain correction

CodeRabbit [4405568024](https://github.com/RunMaestro/Maestro/pull/1944#discussion_r4405568024) found that the timeout error still preceded output written during SIGTERM. Valid, reproduced with a final unterminated JSON envelope: expected data,error, observed error,data (`delivery-drain-red.log`).

The callback now records the host failure without marking the result emitted. Canonical ExitHandler parses/drains the final envelope and flushes output. A temporary, generation-filtered prepended exit observer then emits the host error before consult exit observers. It removes itself before delivery and in finally, including failed/superseded exit handling. No ExitHandler contract or extra implementation file was changed. Forced completion follows the same path.

Regression covers both an initially empty answer and an already-present partial answer followed by final SIGTERM text, final failed consult result, data,error ordering, next-turn reuse and no remaining exit listeners. The resistant predecessor fixture now signals STOPPING when SIGTERM actually arrives, keeping the supersession race regression synchronized with pending termination. Canonical final-envelope behavior selects the final answer rather than concatenating earlier prose; the assertion uses Last answer in both cases.

Final eight focused suites: **487 tests passed**, exit 0 (`delivery-drain-green.log`). Scoped ESLint and Prettier pass. Both independent reviewers accepted this three-file correction, with zero open Standards/Spec findings. Final reviewed source subtree supersedes earlier trees: `6932c0aff9345a29cff19784dc882fd1cf09a4ff`. Exact published head is resolved from the commit containing this update, and final CI must be observed anew. Earlier Windows jobs remain superseded evidence, never final acceptance.

Published drain correction: d287a9a444991297aafac8931bcf0ba5103eeea7. Final source subtree 6932c0aff9345a29cff19784dc882fd1cf09a4ff. Subsequent log EOF normalization changes evidence bytes only and makes the complete rc diff pass git diff --check.

## Fixture stdout completion

CodeRabbit [4405751238](https://github.com/RunMaestro/Maestro/pull/1944#discussion_r4405751238) identified a valid fixture-only risk: immediate process.exit after a pipe write can truncate the final JSON event. Both late-output and normal-success fixture paths now exit from the write callback. Output bytes are preserved, including the normal success newline and the late-output unterminated envelope; CommonJS return prevents success fallthrough into the stall process. Two affected suites: 10 lifecycle tests passed, exit 0 (`delivery-fixture-final.log`). Fixture Prettier check passed. This changes no product implementation and supersedes earlier full-src trees with `ded0c3241ef19eba6dd007f3b054c2d1b9e7c74c`. The 487-test implementation run remains valid for unchanged product files; the affected fixture consumers were rechecked. Final CI is still required at this commit.

## Interrupted drain and full CI failure disposition

CodeRabbit's complete review at e26986476e included an OutsideDiff finding: a user stop while a timed-out process drains should suppress the delayed supervision error, matching canonical ExitHandler interrupted precedence. Reproduced with the resistant fixture: STOPPING then user interruption yielded an unwanted agent_crashed event. The final guard now checks interrupted after removing the exit observer. Parameterized resistant regression covers replacement and interruption, requiring no error and no remaining exit observer for interruption. Both independent reviewers accepted the two-file correction, zero open findings. Eight suites, **488 tests passed**; scoped Prettier and source ESLint passed. Red/green logs: delivery-interrupted-red.log and delivery-interrupted-green.log. Final source subtree supersedes previous trees: `b61e2da832762d23a69f2d43236a30c96e0a4fd5`.

CI attempt on e26986476e: Linux shard 2 failed only at unchanged src/shared/maestro-lib/groupchat/**tests**/observations.test.ts:149 (participantsChanged spy observed before async callback). No groupchat source/test diff against rc. Isolated suite passed all 14 tests. New product-head CI must provide final acceptance; no success is inferred from that isolated pass. No groupchat behavior or test was changed.
