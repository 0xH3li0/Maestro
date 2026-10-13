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

describe('openUiSurface - delegation graph', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('delegationGraph');
	});

	it('opens the Delegation Graph by id and by alias, with no Encore Feature to refuse it', () => {
		expect(openUiSurface('delegation-graph')).toEqual({ ok: true });
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
		// No scope: the graph opens on every agent.
		expect(selectModalData('delegationGraph')(useModalStore.getState())).toBeUndefined();

		useModalStore.getState().closeModal('delegationGraph');
		expect(openUiSurface('delegation')).toEqual({ ok: true });
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
	});

	it('refuses a tab, since the graph has none', () => {
		const result = openUiSurface('delegation-graph', 'peers');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('has no tabs');
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(false);
	});

	it('opens the Delegation Graph on one group (`open delegation-graph --group`)', () => {
		expect(openUiSurface('delegation-graph', undefined, undefined, 'group-1')).toEqual({
			ok: true,
		});

		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
		expect(selectModalData('delegationGraph')(useModalStore.getState())).toEqual({
			scope: { kind: 'group', groupId: 'group-1' },
		});
	});

	it('refuses a group on a surface that does not open on one, and opens nothing', () => {
		useModalStore.getState().closeModal('about');

		const result = openUiSurface('about', undefined, undefined, 'group-1');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('--group does not apply');
		expect(selectModalOpen('about')(useModalStore.getState())).toBe(false);
	});
});

describe('openUiSurface - group settings', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('groupSettings');
	});

	it('opens Group Settings on the group it was given', () => {
		expect(openUiSurface('group-settings', undefined, undefined, 'group-1')).toEqual({ ok: true });
		expect(selectModalOpen('groupSettings')(useModalStore.getState())).toBe(true);
		expect(selectModalData('groupSettings')(useModalStore.getState())).toMatchObject({
			groupId: 'group-1',
		});
	});

	it('is refused without a group, and opens nothing', () => {
		const result = openUiSurface('group-settings');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('pass --group');
		expect(selectModalOpen('groupSettings')(useModalStore.getState())).toBe(false);
	});
});
