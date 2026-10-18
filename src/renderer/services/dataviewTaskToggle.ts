/**
 * dataviewTaskToggle - tick a task from a Dataview `TASK` result in its own file
 * (DV-8), when that file is not the note on screen.
 *
 * A task of the note on screen goes through the surface's own checkbox path
 * (`DataviewDocumentScope.toggleOwnTask`) instead; this covers every other file.
 * The edit is the same one-character rewrite the preview checkboxes make
 * (`toggleTaskCheckboxAtLine`), written with the same `fs.writeFile` call
 * `handleFilePreviewSave()` uses. The vault watcher then emits `dataview:changed`
 * (the result refreshes) and an open tab of that file picks the change up through
 * File Preview's change poller, so no file-tree nudge is needed: File Preview's
 * own toggle sends none either, since a path does not appear or vanish.
 *
 * Guards, each of which resolves false so the checkbox reverts:
 * - an open file tab holds unsaved edits to the file (a write would fork them);
 * - the line no longer holds the task the index reported (the file changed since);
 * - the read or the write fails.
 */

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { taskTextAtLine, toggleTaskCheckboxAtLine } from '../utils/markdownTasks';
import { logger } from '../utils/logger';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

export interface DataviewTaskToggleRequest {
	/** Absolute path of the file that holds the task. */
	filePath: string;
	/** 1-based line of the task's marker. */
	line: number;
	/** The task's text as the index reported it; only its first line is compared. */
	text: string;
	/** The SSH remote the file lives on, if any. */
	sshRemoteId?: string | null;
}

/** One write chain per file, so rapid clicks on two tasks of one file never lose an edit. */
const writeQueue = createKeyedWriteQueue();

/** Whether any open file tab, in any agent, holds unsaved edits to `filePath`. */
function hasUnsavedEdits(filePath: string): boolean {
	return useSessionStore
		.getState()
		.sessions.some((session) =>
			session.filePreviewTabs.some(
				(tab) =>
					tab.path === filePath && tab.editContent !== undefined && tab.editContent !== tab.content
			)
		);
}

/** Toggle one task in its own file. Resolves true once the file is written. */
export function toggleDataviewTaskInFile(request: DataviewTaskToggleRequest): Promise<boolean> {
	const { filePath, line, text, sshRemoteId } = request;
	return writeQueue.enqueue(filePath, async () => {
		if (hasUnsavedEdits(filePath)) {
			notifyToast({
				color: 'yellow',
				title: 'Unsaved Changes',
				message: 'Save or discard your edits to that note before ticking its tasks.',
			});
			return false;
		}
		try {
			const content = await window.maestro.fs.readFile(filePath, sshRemoteId ?? undefined);
			if (content === null) return false;
			// Dataview joins a multi-line task's lines with "\n"; the marker line holds the first.
			const expected = text.split('\n')[0].trim();
			if (taskTextAtLine(content, line) !== expected) return false;
			const result = toggleTaskCheckboxAtLine(content, line);
			if (!result) return false;
			const written = await window.maestro.fs.writeFile(
				filePath,
				result.content,
				sshRemoteId ?? undefined
			);
			return written?.success !== false;
		} catch (err) {
			logger.error('Failed to toggle Dataview task:', undefined, err);
			notifyToast({
				color: 'red',
				title: 'Save Failed',
				message: ipcErrorMessage(err),
			});
			return false;
		}
	});
}
