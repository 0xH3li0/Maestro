/**
 * TabWindowRoot - the reduced root a `?tabWindow=<id>` renderer mounts in place
 * of the full app (Tab Windows, phase 4).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { notifyToast, useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { THEMES } from '../../../../renderer/constants/themes';

async function renderRoot() {
	const view = render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
	return view;
}

beforeEach(() => {
	useNotificationStore.getState().clearToasts();
});

describe('TabWindowRoot', () => {
	it('renders its own window, tagged with the registry id', async () => {
		await renderRoot();
		expect(screen.getByTestId('tab-window-root')).toHaveAttribute('data-tab-window-id', 'tw-7');
	});

	it('loads the settings itself, since App.tsx never mounts here', async () => {
		vi.mocked(window.maestro.settings.getAll).mockClear();
		await renderRoot();
		expect(window.maestro.settings.getAll).toHaveBeenCalled();
	});

	it('follows the active theme', async () => {
		act(() => useSettingsStore.setState({ activeThemeId: 'nord' }));
		await renderRoot();
		expect(screen.getByTestId('tab-window-root')).toHaveStyle({
			backgroundColor: THEMES.nord.colors.bgMain,
		});
	});

	it('hosts toasts raised in this window', async () => {
		await renderRoot();
		act(() => {
			notifyToast({ color: 'green', title: 'Docked', message: 'Back in the main window' });
		});
		expect(await screen.findByText('Docked')).toBeInTheDocument();
	});
});
