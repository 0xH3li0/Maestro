import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	performNotificationInboxAction,
	activateNotification,
} from '../../../renderer/services/notificationInbox';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { notifyToast, useNotificationStore } from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: vi.fn(() => false) }));

const openUrl = vi.fn();
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe('notification inbox operations', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		delete (window.maestro.notification as Partial<typeof window.maestro.notification>)
			.navigateToSource;
		useSessionStore.setState(useSessionStore.getInitialState(), true);
		useSettingsStore.setState({ notificationCenterDetails: false });
		useNotificationStore.setState({ notificationCenterExpandedId: null });
		useNotificationStore.setState({ history: [], toasts: [], notificationCenterOpen: false });
		useNotificationStore.getState().setDefaultDuration(-1);
		useNotificationStore.getState().setOsNotifications(false);
	});
	it('reads and clears the same history seen by the UI, and returns current unread counts', async () => {
		const first = notifyToast({ title: 'First', message: '' });
		const second = notifyToast({ title: 'Second', message: '' });
		expect(await performNotificationInboxAction({ action: 'open' })).toMatchObject({
			success: true,
			open: true,
			unreadCount: 2,
		});
		expect((await performNotificationInboxAction({ action: 'read', id: first })).unreadCount).toBe(
			1
		);
		expect(
			(await performNotificationInboxAction({ action: 'list', unread: true })).notifications?.map(
				(n) => n.id
			)
		).toEqual([second]);
		expect((await performNotificationInboxAction({ action: 'read-all' })).unreadCount).toBe(0);
		expect(useNotificationStore.getState().history.every((n) => n.read)).toBe(true);
		expect((await performNotificationInboxAction({ action: 'clear' })).notifications).toEqual([]);
		expect((await performNotificationInboxAction({ action: 'close' })).open).toBe(false);
	});
	it('shares entry activation while keeping inline links independent and callbacks off the wire', async () => {
		const onClick = vi.fn();
		const id = notifyToast({
			title: 'PR',
			message: '',
			actionUrl: 'https://example.com/pr',
			onClick,
		});
		expect(
			(await performNotificationInboxAction({ action: 'list' })).notifications?.[0]
		).not.toHaveProperty('onClick');
		await performNotificationInboxAction({ action: 'link', id });
		expect(openUrl).toHaveBeenCalledWith('https://example.com/pr');
		expect(onClick).not.toHaveBeenCalled();
		await performNotificationInboxAction({ action: 'activate', id });
		expect(onClick).toHaveBeenCalledOnce();
	});
	it('reports a persistence failure to CLI callers while retaining the resulting snapshot', async () => {
		notifyToast({ title: 'Stored', message: '' });
		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Storage denied');
		});
		try {
			expect(await performNotificationInboxAction({ action: 'clear' })).toMatchObject({
				success: false,
				historyPersistenceFailed: true,
				notifications: [],
			});
		} finally {
			setItem.mockRestore();
		}
	});

	it.each(['read', 'activate', 'link'] as const)(
		'reports failed read persistence for %s',
		async (action) => {
			const id = notifyToast({
				title: 'Stored',
				message: '',
				actionUrl: 'https://example.com',
				onClick: vi.fn(),
			});
			const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
				throw new Error('Storage denied');
			});
			try {
				expect(await performNotificationInboxAction({ action, id })).toMatchObject({
					success: false,
					historyPersistenceFailed: true,
				});
			} finally {
				write.mockRestore();
			}
		}
	);

	it('keeps browser source navigation local instead of focusing the desktop host', async () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		useSessionStore.setState({ sessions: [createMockSession({ id: 'source', name: 'Source' })] });
		const native = vi.fn().mockResolvedValue({ success: true });
		window.maestro.notification.navigateToSource = native;
		const id = notifyToast({
			title: 'Source',
			message: '',
			sessionId: 'source',
			historyOnly: true,
		});
		await activateNotification(useNotificationStore.getState().history.find((n) => n.id === id)!);
		expect(native).not.toHaveBeenCalled();
		expect(useSessionStore.getState().activeSessionId).toBe('source');
	});

	it('routes desktop terminal actions through the owning window', async () => {
		useSessionStore.setState({ sessions: [createMockSession({ id: 'source' })] });
		const native = vi.fn().mockResolvedValue({ success: true });
		window.maestro.notification.navigateToSource = native;
		const clickAction = {
			kind: 'open-terminal' as const,
			sessionId: 'source',
			tabRef: 'terminal-1',
		};
		const id = notifyToast({ title: 'Terminal', message: '', clickAction, historyOnly: true });
		await activateNotification(useNotificationStore.getState().history.find((n) => n.id === id)!);
		expect(native).toHaveBeenCalledWith('source', undefined, clickAction);
	});

	it('reports stale IDs and entries without a link', async () => {
		expect(await performNotificationInboxAction({ action: 'read', id: 'gone' })).toMatchObject({
			success: false,
		});
		const id = notifyToast({ title: 'Plain', message: '' });
		expect(await performNotificationInboxAction({ action: 'link', id })).toMatchObject({
			success: false,
		});
	});
	it('dismisses one entry without discarding history or other visible toasts', async () => {
		useNotificationStore.getState().setDefaultDuration(0);
		const first = notifyToast({ title: 'First', message: '' });
		const second = notifyToast({ title: 'Second', message: '' });
		const result = await performNotificationInboxAction({ action: 'dismiss', id: first });
		expect(result.unreadCount).toBe(1);
		expect(result.notifications).toHaveLength(2);
		expect(useNotificationStore.getState().toasts.map((n) => n.id)).toEqual([second]);
		expect((await performNotificationInboxAction({ action: 'dismiss', id: 'gone' })).success).toBe(
			false
		);
	});

	it('shares opt-in detail expansion with the CLI and does not mark entries read', async () => {
		const id = notifyToast({ title: 'Details', message: 'Full content' });
		expect((await performNotificationInboxAction({ action: 'detail', id })).success).toBe(false);
		useSettingsStore.setState({ notificationCenterDetails: true });
		expect(await performNotificationInboxAction({ action: 'detail', id })).toMatchObject({
			success: true,
			open: true,
			expandedId: id,
			unreadCount: 1,
		});
		expect((await performNotificationInboxAction({ action: 'collapse' })).expandedId).toBe(null);
	});
});
