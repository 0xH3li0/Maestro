/**
 * The Sketch Book tab view (spec sections 2 and 7): an Excalidraw canvas over
 * the sketch's live session in `sketchSessionStore`.
 *
 * The view owns nothing that must outlive it. The scene, the author map and
 * the dirty flag live in the session, so unmounting (switching, tiling,
 * snoozing, closing the tab) loses no stroke; a pending autosave is flushed on
 * the way out.
 *
 * Excalidraw itself loads lazily (`React.lazy` over `loadExcalidraw()`), so
 * no Excalidraw code ships until a sketch opens, and always with the bundled
 * fonts in place.
 *
 * Changes the view did not make (an agent's writes, T5-T8) arrive through the
 * session's `externalRevision` and are merged into Excalidraw by version, as
 * a remote update (not undoable here). An agent's `sketch_focus` (T11) waits
 * in the session until a mounted view scrolls to it; its chat posts (T12)
 * show in the chat pane.
 */

import React from 'react';
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
	ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import type { Theme } from '../../types';
import { mergeNewerSketchElements } from '../../../shared/sketch/agent-writes';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import { Spinner } from '../ui/Spinner';
import { useDebouncedCallback } from '../../hooks/utils/useThrottle';
import {
	SKETCH_AUTOSAVE_DEBOUNCE_MS,
	useSketchSessionStore,
} from '../../stores/sketchSessionStore';
import { loadExcalidraw } from './excalidrawAssets';
import { SketchChatPane } from './SketchChatPane';

const Excalidraw = React.lazy(() =>
	loadExcalidraw().then((module) => ({ default: module.Excalidraw }))
);

/** Excalidraw's theme for a Maestro theme: light stays light, everything else is dark. */
export function excalidrawThemeFor(theme: Theme): 'light' | 'dark' {
	return theme.mode === 'light' ? 'light' : 'dark';
}

type OnChange = NonNullable<ExcalidrawProps['onChange']>;

export interface SketchTabViewProps {
	sketchId: string;
	theme: Theme;
}

function CenteredState({ theme, children }: { theme: Theme; children: React.ReactNode }) {
	return (
		<div
			className="flex-1 flex items-center justify-center"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{children}
		</div>
	);
}

export function SketchTabView({ sketchId, theme }: SketchTabViewProps) {
	const status = useSketchSessionStore((s) => s.sessions[sketchId]?.status);
	const loadError = useSketchSessionStore((s) => s.sessions[sketchId]?.loadError ?? null);
	const saveError = useSketchSessionStore((s) => s.sessions[sketchId]?.saveError ?? null);
	const externalRevision = useSketchSessionStore(
		(s) => s.sessions[sketchId]?.externalRevision ?? 0
	);
	const focusRequest = useSketchSessionStore((s) => s.sessions[sketchId]?.focusRequest ?? null);
	const chat = useSketchSessionStore((s) => s.sessions[sketchId]?.chat);
	const [api, setApi] = React.useState<ExcalidrawImperativeAPI | null>(null);

	React.useEffect(() => {
		void useSketchSessionStore.getState().openSketchSession(sketchId);
	}, [sketchId]);

	const { debouncedCallback: scheduleSave } = useDebouncedCallback(
		() => {
			void useSketchSessionStore.getState().saveSketchSession(sketchId);
		},
		SKETCH_AUTOSAVE_DEBOUNCE_MS,
		{ flushOnUnmount: true }
	);

	const handleChange = React.useCallback<OnChange>(
		(elements, appState: AppState, files: BinaryFiles) => {
			const result = useSketchSessionStore.getState().applyLocalChange(sketchId, {
				elements: elements as unknown as readonly SketchWireElement[],
				appState: appState as unknown as Record<string, unknown>,
				files: files as unknown as Record<string, unknown>,
			});
			if (!result.changed) return;
			// Put the stamp on Excalidraw's own element objects too, in place: the
			// stamp belongs to the version just made, so it must not bump it (an
			// `updateScene` would re-render and fire this handler again). Every
			// later Excalidraw edit carries `customData` forward.
			if (result.stamped.length > 0) {
				const stampById = new Map(result.stamped.map((element) => [element.id, element]));
				for (const element of elements) {
					const stamped = stampById.get(element.id);
					if (stamped) (element as { customData?: unknown }).customData = stamped.customData;
				}
			}
			scheduleSave();
		},
		[sketchId, scheduleSave]
	);

	// Pull in what the session changed without this view (agent writes). Also
	// runs once the API is ready, for a write that landed while Excalidraw
	// loaded. Same versions merge to nothing, so the view's own edits never
	// come back as an update.
	React.useEffect(() => {
		if (!api) return;
		let cancelled = false;
		void loadExcalidraw().then(({ CaptureUpdateAction }) => {
			if (cancelled) return;
			const scene = useSketchSessionStore.getState().sessions[sketchId]?.scene;
			if (!scene) return;
			const viewElements = api.getSceneElementsIncludingDeleted() as unknown as SketchWireElement[];
			const merged = mergeNewerSketchElements(viewElements, scene.elements);
			const changed =
				merged.length !== viewElements.length ||
				merged.some((element, index) => element !== viewElements[index]);
			if (!changed) return;
			api.updateScene({
				elements: merged as unknown as Parameters<
					ExcalidrawImperativeAPI['updateScene']
				>[0]['elements'],
				captureUpdate: CaptureUpdateAction.NEVER,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [api, sketchId, externalRevision]);

	// An agent's `sketch_focus`: scroll and zoom to the elements, then clear it.
	React.useEffect(() => {
		if (!api || !focusRequest) return;
		const wanted = new Set(focusRequest.elementIds);
		const targets = api.getSceneElements().filter((element) => wanted.has(element.id));
		if (targets.length > 0) api.scrollToContent(targets, { fitToContent: true, animate: true });
		useSketchSessionStore.getState().clearSketchFocus(sketchId, focusRequest.nonce);
	}, [api, sketchId, focusRequest]);

	// Read once per mount: Excalidraw owns the canvas after that, and the
	// session catches every change through `onChange`.
	const initialData = React.useMemo<ExcalidrawProps['initialData']>(() => {
		if (status !== 'ready') return null;
		const scene = useSketchSessionStore.getState().sessions[sketchId]?.scene;
		if (!scene) return null;
		return {
			// Copies: Excalidraw mutates its elements in place, and the session's
			// synced scene must keep the versions it last saw.
			elements: scene.elements.map((element) => ({ ...element })),
			appState: scene.appState,
			files: scene.files,
			scrollToContent: true,
		} as unknown as ExcalidrawProps['initialData'];
	}, [sketchId, status]);

	if (status === 'error') {
		return (
			<CenteredState theme={theme}>
				<div className="flex flex-col items-center gap-3 max-w-md text-center select-text">
					<div className="text-sm font-medium" style={{ color: theme.colors.error }}>
						This sketch could not be opened.
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{loadError}
					</div>
					<button
						type="button"
						className="px-3 py-1 rounded text-xs"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						onClick={() => void useSketchSessionStore.getState().openSketchSession(sketchId)}
					>
						Try again
					</button>
				</div>
			</CenteredState>
		);
	}

	const spinner = (
		<CenteredState theme={theme}>
			<Spinner size={24} color={theme.colors.accent} />
		</CenteredState>
	);
	if (status !== 'ready') return spinner;

	return (
		<div
			className="flex-1 min-w-0 min-h-0 relative flex flex-col"
			data-sketch-id={sketchId}
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{saveError && (
				<div
					className="px-3 py-1 text-xs select-text"
					role="alert"
					style={{ color: theme.colors.error, borderBottom: `1px solid ${theme.colors.border}` }}
				>
					Not saved: {saveError}
				</div>
			)}
			<div className="flex-1 min-h-0 flex">
				<div className="flex-1 min-w-0 relative">
					<div className="absolute inset-0">
						<React.Suspense fallback={spinner}>
							<Excalidraw
								key={sketchId}
								initialData={initialData}
								onChange={handleChange}
								excalidrawAPI={setApi}
								theme={excalidrawThemeFor(theme)}
								UIOptions={{ canvasActions: { saveToActiveFile: false } }}
							/>
						</React.Suspense>
					</div>
				</div>
				{chat && chat.length > 0 && <SketchChatPane messages={chat} theme={theme} />}
			</div>
		</div>
	);
}
