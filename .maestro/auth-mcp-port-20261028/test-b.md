---
type: report
title: Consult error and lifecycle regressions
created: 2026-10-28
tags:
  - maestro
  - process-supervision
  - tests
related:
  - '[[PLAN]]'
  - '[[consumers]]'
  - '[[test-a]]'
---

Added isolated desktop runner cases for unrelated IDs, first matching host error, zero exit, and listener cleanup on exit, stop, refused spawn and thrown spawn. Added a service case checking a host error on zero exit retains partial text, suppresses failed continuity and releases the watchdog without a late stop or duplicate result. Existing tests cover clean completion, other exit failures, timeouts, spawn failures and cancellation. These are authored expectations; execution is deferred to CHECKS as requested. No live provider, credentials or MCP service was used. No images were supplied or analyzed.

The process in this worktree was launched with `gpt-6.1-terra` and `model_reasoning_effort=medium` (observed in its `/proc` command line). Prettier formatted the two test files; no test suite was run in this step.
