import type { Session } from '../../../types';
import type { ActiveTabInfo } from '../types';

export function getActiveTabInfo(
	activeSession: Session | undefined,
	isAiMode?: boolean
): ActiveTabInfo {
	const isTerminalMode = activeSession?.inputMode === 'terminal';
	const hasActiveTab = !!(
		isAiMode ||
		isTerminalMode ||
		activeSession?.activeFileTabId ||
		activeSession?.activeBrowserTabId ||
		activeSession?.activeSketchTabId
	);

	let activeTabType: ActiveTabInfo['activeTabType'] = null;
	let activeUnifiedIndex = -1;
	if (activeSession) {
		let type: NonNullable<ActiveTabInfo['activeTabType']>;
		let id: string | undefined | null;
		if (activeSession.activeBrowserTabId) {
			type = 'browser';
			id = activeSession.activeBrowserTabId;
		} else if (isTerminalMode && activeSession.activeTerminalTabId) {
			type = 'terminal';
			id = activeSession.activeTerminalTabId;
		} else if (activeSession.activeFileTabId) {
			type = 'file';
			id = activeSession.activeFileTabId;
		} else if (activeSession.activeSketchTabId) {
			type = 'sketch';
			id = activeSession.activeSketchTabId;
		} else {
			type = 'ai';
			id = activeSession.activeTabId;
		}
		activeTabType = type;
		if (id) {
			activeUnifiedIndex = (activeSession.unifiedTabOrder ?? []).findIndex(
				(ref) => ref.type === type && ref.id === id
			);
		}
	}

	return {
		isTerminalMode,
		hasActiveTab,
		activeUnifiedIndex,
		unifiedTabCount: activeSession?.unifiedTabOrder?.length ?? 0,
		activeTabType,
	};
}
