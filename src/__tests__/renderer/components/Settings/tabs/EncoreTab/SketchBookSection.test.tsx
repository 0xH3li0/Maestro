/**
 * Sketch Book's Settings rows (spec section 8.10, G2): Allow opens the cloud
 * screening confirmation instead of granting directly; OpenJev can be allowed
 * only while it is the engine in force (its consent is bound to a host);
 * Revoke goes through main's consent module.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SketchBookSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { LayerStackProvider } from '../../../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import type { InjectionSourceInfo } from '../../../../../../shared/local-models/injection-screen';
import type { SketchCloudScreenConsent } from '../../../../../../shared/sketch/cloud-consent';
import { mockTheme } from '../../../../../helpers/mockTheme';

const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

const OPENJEV_SOURCE: InjectionSourceInfo = {
	kind: 'openjev',
	locality: 'cloud',
	host: 'gpu.example.com:8000',
	label: 'OpenJev',
};

function status(consent: SketchCloudScreenConsent, source: InjectionSourceInfo | null) {
	return { consent, source, sourceCovered: false, rooms: [] };
}

function renderSection() {
	render(
		<LayerStackProvider>
			<SketchBookSection theme={mockTheme} />
		</LayerStackProvider>
	);
}

function row(engine: 'jev' | 'openjev') {
	return screen.getByTestId(`sketch-book-consent-${engine}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState({ sketchBookSettings: {} });
	sketchApi.screeningConsentStatus.mockResolvedValue(status({}, null));
	sketchApi.grantScreeningConsent.mockResolvedValue(status({ jev: { grantedAt: 1 } }, null));
	sketchApi.revokeScreeningConsent.mockResolvedValue(status({}, null));
});

describe('Allow', () => {
	it('opens the confirmation for Jev and grants only on Allow', async () => {
		renderSection();
		fireEvent.click(await screen.findByRole('button', { name: 'Allow...' }));
		expect(screen.getByRole('dialog', { name: 'Cloud screening' })).toBeInTheDocument();
		expect(sketchApi.grantScreeningConsent).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
		await waitFor(() =>
			expect(sketchApi.grantScreeningConsent).toHaveBeenCalledWith('jev', undefined)
		);
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('Keep local closes the confirmation without granting or switching the screen', async () => {
		renderSection();
		fireEvent.click(await screen.findByRole('button', { name: 'Allow...' }));
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(sketchApi.grantScreeningConsent).not.toHaveBeenCalled();
		expect(sketchApi.localScreenOption).not.toHaveBeenCalled();
	});

	it('explains that OpenJev must be the engine in force before it can be allowed', async () => {
		renderSection();
		await waitFor(() => expect(sketchApi.screeningConsentStatus).toHaveBeenCalled());
		expect(row('openjev')).toHaveTextContent(/set OpenJev as the System One engine first/);
		expect(row('openjev').querySelector('button')).toBeNull();
	});

	it('allows OpenJev for the host in force', async () => {
		sketchApi.screeningConsentStatus.mockResolvedValue(status({}, OPENJEV_SOURCE));
		renderSection();
		await waitFor(() => expect(row('openjev').querySelector('button')).not.toBeNull());
		fireEvent.click(row('openjev').querySelector('button')!);
		expect(screen.getByText('OpenJev at gpu.example.com:8000')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
		await waitFor(() =>
			expect(sketchApi.grantScreeningConsent).toHaveBeenCalledWith(
				'openjev',
				'gpu.example.com:8000'
			)
		);
	});

	it('offers a new OpenJev host when the consent is bound to another one', async () => {
		sketchApi.screeningConsentStatus.mockResolvedValue(
			status({ openjev: { host: 'old.example.com', grantedAt: 1 } }, OPENJEV_SOURCE)
		);
		renderSection();
		expect(
			await screen.findByRole('button', { name: 'Allow gpu.example.com:8000...' })
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
	});
});

describe('Revoke', () => {
	it('revokes a granted engine through main', async () => {
		sketchApi.screeningConsentStatus.mockResolvedValue(status({ jev: { grantedAt: 1 } }, null));
		renderSection();
		fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
		expect(sketchApi.revokeScreeningConsent).toHaveBeenCalledWith('jev');
		expect(row('jev')).toHaveTextContent(/Allowed/);
	});
});
