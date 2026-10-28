---
type: report
title: Auth and MCP lifecycle regression fixtures
created: 2026-10-28
tags:
  - maestro
  - process-supervision
  - tests
related:
  - '[[PLAN]]'
  - '[[core]]'
  - '[[consumers]]'
---

## Scope and cases

Adapted the three requested files from pinned source `5d72b672fa7b9481087c112fc12166e8a17eb47d`. The Linux-only, credential-free fixture starts a real silent child and emits synthetic Codex JSONL. CLI cases cover startup, post-model and MCP-tool stalls with compressed default budgets, failure diagnostics, descendant termination, and a normal successful result. Desktop cases cover the same stalls, progress and tool allowances, one error and failed exit, descendant cleanup, survival of an unrelated process, and a subsequent successful turn in the same session. Owned processes are terminated in cleanup; test deadlines bound the stall checks. Temporary CLI data stays under this artifact directory. Existing current-rc parser routing is used rather than the source's removed observer API.

These are authored expectations, not verified results: this task explicitly prohibits executing tests. The subsequent CHECKS task must run them and address failures. No real credentials, provider or MCP service are used. No images were supplied or analyzed.

The actual task process `/proc/221798` had this worktree as cwd and used `gpt-6.1-terra` with `model_reasoning_effort=medium`; this is execution evidence for the assigned medium tier. Formatting is limited to the three test files; no full suite or validation push was run.
