/**
 * Auto Run steering - operator-side helpers.
 *
 * The steering surface is the Thought Stream panel, and nothing here touches an
 * AI tab. That is the whole point of the split: an Auto Run dispatches a fresh
 * agent per task, so a note is a property of the RUN, and routing it through the
 * chat composer made a message typed at an agent silently mean something else.
 * The panel owns both halves of the gesture now - the Steer button that sends a
 * note, and the list that shows what is still pending.
 *
 * `submitSteeringNote` parks a note; `takeSteeringNotesForDispatch` hands the
 * pending ones to the task about to run; `recordSteeringResponse` brings that
 * task's reply back to them. All three live here rather than in the store
 * so the store stays pure state, and rather than in the panel so the batch
 * runner can consume notes without importing anything from the view layer.
 */

import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useAutoRunSteeringStore } from '../stores/autoRunSteeringStore';
import {
	MAX_PENDING_STEERING_NOTES,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';

export interface SubmitSteeringNoteArgs {
	sessionId: string;
	text: string;
}

/**
 * Park a steering note for the next Auto Run task.
 *
 * Returns `false` when the note was not accepted (empty text, or the pending cap
 * is reached) and says so on screen. A refusal has to be visible: the only other
 * record of the note is the pending list, so a silent `false` would read as the
 * Send button doing nothing.
 */
export function submitSteeringNote(args: SubmitSteeringNoteArgs): boolean {
	const { sessionId, text } = args;
	const note = useAutoRunSteeringStore.getState().addNote(sessionId, text);
	if (!note) {
		// An empty draft is the caller's to guard; reaching here with text means
		// the cap bit, which is the case worth naming.
		if (normalizeSteeringNoteText(text)) {
			notifyCenterFlash({
				message: 'Too many steering notes',
				detail: `${MAX_PENDING_STEERING_NOTES} are already waiting for the next task`,
				color: 'orange',
			});
		}
		return false;
	}

	notifyCenterFlash({
		message: 'Steering note queued',
		detail: 'Delivered at the start of the next Auto Run task',
		color: 'theme',
	});
	return true;
}

/**
 * Cancel a pending note. No-op once a task has taken it - the note has moved to
 * the delivered list, and un-sending something the agent already read is not a
 * thing this can offer.
 */
export function cancelSteeringNote(sessionId: string, noteId: string): void {
	useAutoRunSteeringStore.getState().removeNote(sessionId, noteId);
}

/**
 * Consume every pending note for a session, for the task that is about to be
 * dispatched.
 *
 * Read-and-clear is atomic in the store, so a note the operator sends between
 * this call and the spawn belongs to the NEXT task rather than being lost.
 */
export function takeSteeringNotesForDispatch(sessionId: string): AutoRunSteeringNote[] {
	return useAutoRunSteeringStore.getState().takeNotes(sessionId);
}

/**
 * Attach a finished task's reply to the notes it was dispatched with, so the
 * panel can show what the agent did about them.
 *
 * Called for EVERY settled task, failed ones included: a note whose task blew up
 * must say so rather than sit on "working on it" for the rest of the run. No-op
 * for a task that took no notes, which is nearly all of them.
 */
export function recordSteeringResponse(
	sessionId: string,
	notes: readonly AutoRunSteeringNote[],
	response: { summary: string; text: string; success: boolean }
): void {
	if (notes.length === 0) return;
	useAutoRunSteeringStore.getState().recordResponse(
		sessionId,
		notes.map((note) => note.id),
		response
	);
}

/** Clear anything pending or delivered. Run START owns this: a new run begins clean. */
export function clearSteeringNotes(sessionId: string): void {
	useAutoRunSteeringStore.getState().clearNotes(sessionId);
}

/**
 * Drop the notes no task took, keeping the delivered record and its replies.
 * Run END owns this. The reply to a run's last note lands as the run finishes,
 * so clearing the delivered list here would erase it the moment it arrived.
 */
export function clearPendingSteeringNotes(sessionId: string): void {
	useAutoRunSteeringStore.getState().clearPendingNotes(sessionId);
}
