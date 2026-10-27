/**
 * The cloud screening confirmation (CloudScreeningConsentDialog, spec section
 * 8.10 G2 and G3): it names the engine and its host, says what leaves the
 * machine and what guests will see; Allow grants the consent through main's
 * consent module (bound to the host it named); Keep local changes nothing and
 * offers to switch the screen back to a local classifier.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudScreeningConsentDialog } from '../../../../renderer/components/SketchBook/CloudScreeningConsentDialog';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { SketchCloudConfirmNeeded } from '../../../../shared/sketch/cloud-consent';
import { mockTheme } from '../../../helpers/mockTheme';

const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

function renderDialog(prompt: SketchCloudConfirmNeeded, onClose = vi.fn()) {
	render(
		<LayerStackProvider>
			<CloudScreeningConsentDialog theme={mockTheme} prompt={prompt} onClose={onClose} />
		</LayerStackProvider>
	);
	return onClose;
}

const JEV: SketchCloudConfirmNeeded = { engine: 'jev', host: 'api.typesafe.ai', reason: 'grant' };
const OPENJEV: SketchCloudConfirmNeeded = {
	engine: 'openjev',
	host: 'gpu.example.com:8000',
	reason: 'live-switch',
};

beforeEach(() => {
	vi.clearAllMocks();
	sketchApi.localScreenOption.mockResolvedValue({ installed: null });
	sketchApi.switchScreenToLocal.mockResolvedValue({ installed: true, assigned: true });
});

describe('what the dialog says', () => {
	it('names Jev, its maker and its host, what leaves the machine, and the guest badge', () => {
		renderDialog(JEV);
		expect(screen.getByRole('dialog', { name: 'Cloud screening' })).toBeInTheDocument();
		expect(screen.getByText('Jev, by TypeSafe, api.typesafe.ai')).toBeInTheDocument();
		expect(
			screen.getByText(/decrypted guest chat and canvas text, and your agent's replies before/)
		).toBeInTheDocument();
		expect(screen.getByText(/Guests will see "Screened by a cloud service"/)).toBeInTheDocument();
	});

	it('names Jev on its hosted service when the source carries no host', () => {
		renderDialog({ engine: 'jev', reason: 'grant' });
		expect(screen.getByText('Jev, by TypeSafe, api.typesafe.ai')).toBeInTheDocument();
	});

	it('names an OpenJev server by its host, and says why it asks again on a live switch', () => {
		renderDialog(OPENJEV);
		expect(screen.getByText('OpenJev at gpu.example.com:8000')).toBeInTheDocument();
		expect(
			screen.getByText(/changed to OpenJev at gpu.example.com:8000 while a shared/)
		).toBeInTheDocument();
	});
});

describe('Allow', () => {
	it('grants the consent for the engine and host it named, then closes', async () => {
		const onClose = renderDialog(OPENJEV);
		fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(sketchApi.grantScreeningConsent).toHaveBeenCalledWith('openjev', 'gpu.example.com:8000');
		expect(sketchApi.switchScreenToLocal).not.toHaveBeenCalled();
	});

	it('stays open with the reason when the grant fails', async () => {
		sketchApi.grantScreeningConsent.mockRejectedValueOnce(new Error('Sketch Book is off.'));
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Sketch Book is off.');
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
	});
});

describe('Keep local', () => {
	it('grants nothing and offers the installed local classifier', async () => {
		sketchApi.localScreenOption.mockResolvedValueOnce({
			installed: { modelId: 'prompt-guard-2-22m', label: 'Prompt Guard 2 22M' },
		});
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));

		const use = await screen.findByRole('button', {
			name: 'Use Prompt Guard 2 22M on this computer',
		});
		expect(sketchApi.grantScreeningConsent).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Nothing goes to Jev, by TypeSafe, api.typesafe.ai/)
		).toBeInTheDocument();

		fireEvent.click(use);
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(sketchApi.switchScreenToLocal).toHaveBeenCalledTimes(1);
	});

	it('offers the Prompt Guard 2 download when no local classifier is installed', async () => {
		renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
		expect(
			await screen.findByRole('button', { name: /^Download Prompt Guard 2/ })
		).toBeInTheDocument();
		expect(screen.getByText(/No local classifier is installed/)).toBeInTheDocument();
	});

	it('Not now closes without switching anything', async () => {
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(sketchApi.switchScreenToLocal).not.toHaveBeenCalled();
		expect(sketchApi.grantScreeningConsent).not.toHaveBeenCalled();
	});

	it('shows a failed switch and stays open', async () => {
		sketchApi.switchScreenToLocal.mockResolvedValueOnce({
			installed: false,
			assigned: false,
			error: 'Network down.',
		});
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
		fireEvent.click(await screen.findByRole('button', { name: /^Download Prompt Guard 2/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Network down.');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('says so when the screen got another source meanwhile', async () => {
		sketchApi.switchScreenToLocal.mockResolvedValueOnce({ installed: true, assigned: false });
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
		fireEvent.click(await screen.findByRole('button', { name: /^Download Prompt Guard 2/ }));
		expect(await screen.findByRole('status')).toHaveTextContent(/another source/);
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('closing', () => {
	it('the ESC pill closes as "Not now", allowing nothing', () => {
		const onClose = renderDialog(JEV);
		fireEvent.click(screen.getByRole('button', { name: 'Not now (Esc)' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(sketchApi.grantScreeningConsent).not.toHaveBeenCalled();
	});
});
