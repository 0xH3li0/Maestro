---
type: report
title: Vitest Tier A jsdom Directory Merges
created: 2026-10-16
tags:
  - vitest
  - performance
  - test-consolidation
related:
  - '[[vitest-tier-a-before-state-2026-10-15]]'
  - '[[01 - Tier A Small-Average Directories]]'
---

# Tier A jsdom directory merges

Tests and suite names are preserved. Imports are combined, colliding module-local bindings are mechanically renamed, and file-level lifecycle hooks are moved into their original top-level suites. Different factories for the same module remain in separate files. No application code or shared Vitest configuration changes. Clusters remain under 1,500 lines; existing oversized files stay unmerged.

Every playbook run uses command-scoped `NODE_ENV=test` and the approved newline-safe filter `^(?![\s\S]*does not overwrite a preexisting attachment file symlink)[\s\S]*$`. Full-suite results are filtered coverage, not unfiltered coverage. Expected full-suite totals: 45,524 passed, zero failed, 119 skipped (45,643 total).

## Directory gates

| Stage | Directory under src/**tests**                  | Files before → after | Passed / total | Vitest wall | Mock conflicts / notes                                                                                                                                   |
| ----- | ---------------------------------------------- | -------------------- | -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `renderer/hooks/ui`                            | 22 → 3               | 182 / 182      | 6.83s       | runtimeContext false/true factories split between layout and gestures; Original file-level hooks scoped to existing describes; local collisions renamed. |
| 2     | `renderer/components/FilePreview/markdownFast` | 14 → 2               | 229 / 229      | 1.73s       | No same-module factory conflicts; Highlighter/preview and parser/pipeline domains separated.                                                             |

Directory JSON receipts: `Working/vt-fu-a-stage<N>.json` in the shared playbook folder. Warnings are retained; green assertions do not imply warning-free execution.

## Full-suite checkpoints

No two-stage checkpoint reached yet.

## File mapping

### renderer/hooks/ui

- `preferences.merged.test.tsx` ← `usePersistedChoice.test.tsx`, `usePersistedPanelWidth.test.tsx`, `usePersistedToggle.test.tsx`, `useFontScale.test.tsx`, `usePagination.test.tsx`, `useTableSort.test.tsx`, `useScaleShortcuts.test.tsx`, `useIsTopLayer.test.tsx`, `useRestartWhenIdle.test.tsx`, `useIdleNotification.test.tsx`
- `layout.merged.test.tsx` ← `useAnchoredMenuPosition.test.tsx`, `useAutosizeTextarea.test.tsx`, `useFreeHeightInFlexColumn.test.tsx`, `useFreeWidthInFlexRow.test.tsx`, `useHeaderTextDelta.test.ts`, `useHorizontalScroll.test.tsx`, `useResizableDropdownHeight.test.tsx`, `useViewportBreakpoint.test.ts`
- `gestures.merged.test.tsx` ← `useDragAutoScroll.test.tsx`, `usePanZoom.test.tsx`, `useChatFileDropZone.test.tsx`, `useLayerSwipeDismiss.test.ts`

### renderer/components/FilePreview/markdownFast

- `rendering.merged.test.tsx` ← `MarkdownPreviewFast.test.tsx`, `alertTagger.test.ts`, `blocks.test.ts`, `codeHighlighter.test.ts`, `escapeHtml.test.ts`, `frontmatter.test.ts`, `headingSlugger.test.ts`
- `pipeline.merged.test.tsx` ← `linkRouter.test.ts`, `mermaidRenderer.test.ts`, `parser.test.ts`, `pipeline.test.ts`, `proseStyles.test.ts`, `sanitize.test.ts`, `searchHits.test.ts`
