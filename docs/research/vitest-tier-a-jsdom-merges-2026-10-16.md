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

| Stage | Directory under src/**tests**                  | Files before → after | Passed / total | Vitest wall | Mock conflicts / notes                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------- | -------------------- | -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `renderer/hooks/ui`                            | 22 → 3               | 182 / 182      | 6.83s       | runtimeContext false/true factories split between layout and gestures; Original file-level hooks scoped to existing describes; local collisions renamed.                                                                                                                         |
| 2     | `renderer/components/FilePreview/markdownFast` | 14 → 2               | 229 / 229      | 1.73s       | No same-module factory conflicts; Highlighter/preview and parser/pipeline domains separated.                                                                                                                                                                                     |
| 3     | `renderer/hooks/agent/internal`                | 15 → 4               | 152 / 152      | 3.73s       | Ownership WindowContext factory contaminated tool capture: 8 initial failures; ownership suite restored verbatim as an isolated file; Final directory run includes 80 unchanged descendant-helper tests (232 total); exact parent remains 152.                                   |
| 4     | `renderer/hooks/batch`                         | 21 → 6               | 273 / 273      | 10.43s      | Remote processor mocked real kill/document/worktree hooks: 25 initial failures, resolved by restoring its source as an isolated file; 1,760-line worktree suite stays unmerged. Descendants add 21 tests (294 total).                                                            |
| 5     | `renderer/hooks/cue`                           | 16 → 7               | 273 / 273      | 2.29s       | Viewport pipelineGraph mock omitted resolvePipelineOffset required by real layout: 14 initial failures / 17 unhandled errors; both original files retained separately. Other persistence/selection/state factory conflicts remain isolated.                                      |
| 6     | `renderer/hooks/tabs/internal`                 | 10 → 2               | 102 / 102      | 2.60s       | Helper/AI/terminal and browser/file/unified-handler domains separated; no mock conflict failures.                                                                                                                                                                                |
| 7     | `renderer/hooks/remote`                        | 9 → 3                | 86 / 86        | 10.04s      | Identical capture-free event-listener factories deduplicated; goal-run settings/selector factories and group store/ID factories remain isolated.                                                                                                                                 |
| 8     | `renderer/hooks/utils`                         | 9 → 2                | 183 / 183      | 2.62s       | Interaction/callback/gesture suites combined; existing 2,753-line debounced-persistence suite remains unmerged.                                                                                                                                                                  |
| 9     | `renderer/components/DocumentGraph`            | 22 → 11              | 775 / 775      | 10.17s      | Screenshot graphDataBuilder factory kept separate from real data tests; oversized DocumentGraphView and large mind-map layout remain unchanged. Documentation-only drag/zoom and synthetic performance fixtures left untouched rather than re-pinned as new behavioral coverage. |

Directory JSON receipts: `Working/vt-fu-a-stage<N>.json` in the shared playbook folder. Warnings are retained; green assertions do not imply warning-free execution.

## Full-suite checkpoints

- After stages 1–2: **45,524 passed / 0 failed / 119 skipped; 1,675 files**, filtered full suite passed. Receipt: `Working/vt-fu-a-checkpoint2.log` and `.json`.
- After stages 3–4: **45,524 passed / 0 failed / 119 skipped; 1,649 files**, filtered full suite passed. Receipt: `Working/vt-fu-a-checkpoint4.log` and `.json`.
- After stages 5–6: **45,524 passed / 0 failed / 119 skipped; 1,632 files**, filtered full suite passed. Receipt: `Working/vt-fu-a-checkpoint6.log` and `.json`.
- After stages 7–8: **45,524 passed / 0 failed / 119 skipped; 1,619 files**, filtered full suite passed. Receipt: `Working/vt-fu-a-checkpoint8.log` and `.json`.

## File mapping

### renderer/hooks/ui

- `preferences.merged.test.tsx` ← `usePersistedChoice.test.tsx`, `usePersistedPanelWidth.test.tsx`, `usePersistedToggle.test.tsx`, `useFontScale.test.tsx`, `usePagination.test.tsx`, `useTableSort.test.tsx`, `useScaleShortcuts.test.tsx`, `useIsTopLayer.test.tsx`, `useRestartWhenIdle.test.tsx`, `useIdleNotification.test.tsx`
- `layout.merged.test.tsx` ← `useAnchoredMenuPosition.test.tsx`, `useAutosizeTextarea.test.tsx`, `useFreeHeightInFlexColumn.test.tsx`, `useFreeWidthInFlexRow.test.tsx`, `useHeaderTextDelta.test.ts`, `useHorizontalScroll.test.tsx`, `useResizableDropdownHeight.test.tsx`, `useViewportBreakpoint.test.ts`
- `gestures.merged.test.tsx` ← `useDragAutoScroll.test.tsx`, `usePanZoom.test.tsx`, `useChatFileDropZone.test.tsx`, `useLayerSwipeDismiss.test.ts`

### renderer/components/FilePreview/markdownFast

- `rendering.merged.test.tsx` ← `MarkdownPreviewFast.test.tsx`, `alertTagger.test.ts`, `blocks.test.ts`, `codeHighlighter.test.ts`, `escapeHtml.test.ts`, `frontmatter.test.ts`, `headingSlugger.test.ts`
- `pipeline.merged.test.tsx` ← `linkRouter.test.ts`, `mermaidRenderer.test.ts`, `parser.test.ts`, `pipeline.test.ts`, `proseStyles.test.ts`, `sanitize.test.ts`, `searchHits.test.ts`

### renderer/hooks/agent/internal

- `events.merged.test.tsx` ← `noteProviderModeTransition.test.ts`, `useAgentCommandExitListener.test.tsx`, `useAgentDataListener.test.tsx`, `useAgentErrorListener.test.tsx`, `useAgentSessionIdListener.test.tsx`, `useAgentSlashCommandsListener.test.tsx`, `useAgentSshRemoteListener.test.tsx`, `useAgentStderrListener.test.tsx`
- `execution.merged.test.tsx` ← `useAgentExitListener.test.tsx`, `useAgentThinkingListener.test.tsx`, `useAgentToolExecutionListener.test.tsx`, `useThoughtStreamCaptureListener.test.tsx`
- `usage.merged.test.tsx` ← `useAgentUsageListener.test.tsx`, `useThoughtStreamToolListener.test.tsx`
- Unmerged `useOwnedSessionGate.test.tsx`

### renderer/hooks/batch

- `summaries.merged.test.tsx` ← `batchFinalSummary.test.ts`, `batchFlushState.test.ts`, `batchLoopSummary.test.ts`, `batchProgressPoll.test.ts`, `batchUtilsHitl.test.ts`, `batchUtilsHumanSteps.test.ts`, `playbookAutoName.test.ts`, `useBatchSelectors.test.ts`
- `state.merged.test.tsx` ← `batchReducer.test.ts`, `useAutoRunHandlers.refresh.test.ts`, `useAutoRunHandlers.remote.test.ts`, `useAutoRunStateMirror.test.ts`
- Unmerged `useAutoRunHandlers.worktree.test.ts`
- `actions.merged.test.tsx` ← `useBatchBroadcast.test.ts`, `useBatchControlActions.test.ts`, `useBatchKillAction.test.ts`, `useDocumentProcessor.steering.test.ts`, `useWorktreeManager.test.ts`
- `runners.merged.test.tsx` ← `useGoalRunner.test.ts`, `useTimeTracking.test.ts`
- Unmerged `useBatchProcessor.remote.test.ts`

### renderer/hooks/cue

- `graph.merged.test.tsx` ← `pendingEditsRegistry.test.ts`, `useCueGraphData.test.ts`, `useCueToggle.test.ts`, `useCueVisibilityWiring.test.ts`, `usePipelineCanvasCallbacks.test.ts`, `usePipelineContextMenu.test.ts`
- `editing.merged.test.tsx` ← `useCueSettings.test.ts`, `usePipelineCrud.test.ts`, `usePipelineKeyboard.test.ts`, `usePipelineMutations.test.ts`, `usePipelineSelection.multiTrigger.test.ts`
- Unmerged `usePipelineLayout.test.ts`
- Unmerged `usePipelinePersistence.test.ts`
- Unmerged `usePipelineSelection.test.ts`
- Unmerged `usePipelineState.test.ts`
- Unmerged `usePipelineViewport.test.ts`

### renderer/hooks/tabs/internal

- `helpers.merged.test.tsx` ← `browserTabHelpers.test.ts`, `filePreviewTabHelpers.test.ts`, `unifiedCloseHelpers.test.ts`, `useAITabHandlers.test.ts`, `useScrollLogHandlers.test.ts`, `useTabDerivedState.test.ts`, `useTerminalTabHandlers.test.ts`
- `handlers.merged.test.tsx` ← `useBrowserTabHandlers.test.ts`, `useFilePreviewTabHandlers.test.ts`, `useUnifiedTabHandlers.test.ts`

### renderer/hooks/remote

- `events.merged.test.tsx` ← `goalRunLaunch.test.ts`, `useAppRemoteEventListenersAutoRunRefresh.test.ts`, `useAppRemoteEventListenersBrowserTabs.test.ts`, `useAppRemoteEventListenersOpenFile.test.ts`, `useAppRemoteEventListenersSessionConfig.test.ts`, `useAppRemoteEventListenersSessionCwd.test.ts`, `useLiveOverlay.test.ts`
- Unmerged `useAppRemoteEventListenersGoalRun.test.ts`
- Unmerged `useAppRemoteEventListenersGroups.test.ts`

### renderer/hooks/utils

- `interaction.merged.test.tsx` ← `useBracketTabCycle.test.ts`, `useEdgeSwipeHandlers.test.ts`, `useEventListener.test.ts`, `useLongPress.test.ts`, `usePointerDrag.test.ts`, `useProgressiveRenderWindow.test.ts`, `useStableCallback.test.tsx`, `useSwipeGestures.test.ts`
- Unmerged `useDebouncedPersistence.test.ts`

### renderer/components/DocumentGraph

- Unmerged `DocumentGraphView.test.tsx`
- `nodes.merged.test.tsx` ← `DocumentNode.test.tsx`, `ExternalLinkNode.test.tsx`, `neighborDepth.test.ts`
- `navigation.merged.test.tsx` ← `GraphLegend.test.tsx`, `GraphMiniMap.test.tsx`, `NodeBreadcrumb.test.tsx`, `clusterColors.test.ts`, `openIconRect.test.ts`, `viewportResize.test.ts`
- Unmerged `NodeContextMenu.test.tsx`
- `data.merged.test.tsx` ← `graphDataBuilder.test.ts`, `previewCharLimit.test.ts`, `previewPaneSizing.test.ts`
- `layout.merged.test.tsx` ← `graphScopeMode.test.ts`, `layoutAlgorithms.test.ts`
- Unmerged `mindMapLayouts.test.ts`
- `rendering.merged.test.tsx` ← `orphanLayout.test.ts`, `scrollMode.test.ts`
- Unmerged `graph-screenshot.test.tsx`
- Unmerged `graph-drag-zoom.test.ts`
- Unmerged `reactflow-performance.test.ts`
