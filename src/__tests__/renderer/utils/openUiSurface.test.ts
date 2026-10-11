/**
 * @file openUiSurface.test.ts
 * @description `maestro-cli open feedback` must behave like the Feedback
 * button: open the modal fresh, or restore a parked draft instead of replacing
 * it (which would throw the running conversation away).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import {
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../renderer/stores/modalStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';

describe('openUiSurface - feedback', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('feedback');
		useFeedbackDraftStore.getState().reset();
	});

	it('opens the Send Feedback modal', () => {
		expect(openUiSurface('feedback')).toEqual({ ok: true });
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});

	it('restores a minimized draft rather than opening a fresh modal', () => {
		useModalStore.getState().openModal('feedback');
		useFeedbackDraftStore.getState().setMinimized(true);

		expect(openUiSurface('feedback')).toEqual({ ok: true });

		expect(useFeedbackDraftStore.getState().isMinimized).toBe(false);
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});
});

describe('openUiSurface - quick-chat', () => {
	it('shows the Quick Chat window through the main process, not as a modal', () => {
		const show = vi.mocked(window.maestro.quickChat.window);
		show.mockClear();
		expect(openUiSurface('quick-chat')).toEqual({ ok: true });
		expect(show).toHaveBeenCalledWith('show');
	});
});

describe('openUiSurface - settings deep links', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('settings');
	});

	it('opens Settings on the Models tab and the inner tab asked for', () => {
		expect(openUiSurface('settings', 'models', 'system-one')).toEqual({ ok: true });
		expect(selectModalOpen('settings')(useModalStore.getState())).toBe(true);
		expect(selectModalData('settings')(useModalStore.getState())).toMatchObject({
			tab: 'models',
			subTab: 'system-one',
		});
	});

	it('still opens `local-models` as the Models tab', () => {
		expect(openUiSurface('settings', 'local-models')).toEqual({ ok: true });
		const data = selectModalData('settings')(useModalStore.getState());
		expect(data).toMatchObject({ tab: 'models' });
		expect(data?.subTab).toBeUndefined();
	});

	it('refuses an unknown inner tab and opens nothing', () => {
		const result = openUiSurface('settings', 'models', 'nope');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Valid sub-tabs: library');
		expect(selectModalOpen('settings')(useModalStore.getState())).toBe(false);
	});

	it('refuses an inner tab without a tab', () => {
		const result = openUiSurface('settings', undefined, 'library');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('--sub-tab needs --tab');
	});
});
