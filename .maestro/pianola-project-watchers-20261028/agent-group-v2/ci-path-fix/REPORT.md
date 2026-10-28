---
type: report
title: Pianola PR1942 Linux Lite data path repair and rc integration
created: 2026-10-28
tags:
  - pianola
  - linux
  - ci
related:
  - '[[PIANOLA-CI-PATH-01]]'
---

# Pianola PR1942 integration report

## Outcome

The Linux Lite failure was a stale test expectation: the canonical data-directory resolver and desktop startup use lowercase `maestro` on Linux. The only product change is a test correction with an isolated XDG fixture and legacy-state coverage. Production path selection and user data were not changed.

## Integration and publication

The previously published feature head `0d0a0b7ce82647d641b8f9cf8e03ea0263570754` was integrated with fetched upstream `rc` at `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06` by merge commit `c9d202bc6f473658954442ac7d5ce44558b7a8f5`. Both are ancestors. The Lite test conflict retained the isolated fixture, lowercase Linux default, legacy-state regression, and existing override assertions. PR #1942 was updated by a normal fast-forward push; its live head has since advanced to `c4f6f4c7029527427e11fa7946566c130ae62333` through an evidence refresh commit.

## Checks

- RS01: 35 tests across 2 files passed; receipt `checks/rs01-lite-canonical.log`.
- RS02: 111 tests across 5 files passed; receipt `checks/rs02-affected.log`.
- Full local suite and full pre-push hook suite were skipped per task scope; the hook override was command-scoped.
- Actual execution models are unknown; configured model tiers are hints only.

## CI and next action

PR #1942 is [open](https://github.com/RunMaestro/Maestro/pull/1942) against `rc` at `1fe7a03b072f63a0f0ced53b1f5eb1b8f8f3fe06`, current head `c4f6f4c7029527427e11fa7946566c130ae62333`, and reported `UNSTABLE` while checks run. Exact-head GitHub Actions run [40755667294](https://github.com/RunMaestro/Maestro/actions/runs/40755667294) is in progress: lint/format and Ubuntu and Windows test shards have not completed. Earlier run [40755290077](https://github.com/RunMaestro/Maestro/actions/runs/40755290077) remains in progress for merge head `c9d202bc6f473658954442ac7d5ce44558b7a8f5`; it is not the current PR head. CI is running, not green. Mira is the next actor via the existing completion callback and should inspect run 40755667294 for the current head, then address any confirmed failure. The configured default `gh` context is `chr1syy/Maestro`, so explicit `--repo RunMaestro/Maestro` is required. No merge, installation, restart, or live activation was performed.
