import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { FloatingWidgetRoot } from '../../../renderer/floatingWidget/FloatingWidgetRoot';
import { logger } from '../../../renderer/utils/logger';

const maestro = window.maestro as unknown as Record<string, unknown>;
const original = maestro.floatingWidgets;

let ready: ReturnType<typeof vi.fn>;

function openAs(search: string) {
	window.history.replaceState(null, '', `/${search}`);
}

async function renderRoot() {
	const result = render(
		<StrictMode>
			<FloatingWidgetRoot />
		</StrictMode>
	);
	await act(async () => {});
	return result;
}

beforeEach(() => {
	ready = vi.fn();
	maestro.floatingWidgets = { ready, hide: vi.fn().mockResolvedValue(false) };
});

afterEach(() => {
	maestro.floatingWidgets = original;
	window.history.replaceState(null, '', '/');
	vi.restoreAllMocks();
});

describe('FloatingWidgetRoot', () => {
	it('renders nothing and logs for an unknown id', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		openAs('?floatingWidget=not-a-widget');
		const { container } = await renderRoot();
		expect(container).toBeEmptyDOMElement();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-widget'), 'FloatingWidget');
		expect(ready).not.toHaveBeenCalled();
	});

	it('renders nothing when the parameter is empty', async () => {
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
		openAs('?floatingWidget=');
		const { container } = await renderRoot();
		expect(container).toBeEmptyDOMElement();
		expect(ready).not.toHaveBeenCalled();
	});

	it('renders the body for a known id', async () => {
		openAs('?floatingWidget=throughput-gauge');
		await renderRoot();
		expect(screen.getByTestId('floating-widget-frame')).toBeInTheDocument();
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('Throughput');
	});

	it('renders the media player body for its id', async () => {
		openAs('?floatingWidget=media-player');
		await renderRoot();
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('Media Player');
	});

	it('calls ready once with the id, even under StrictMode', async () => {
		openAs('?floatingWidget=media-player');
		const { rerender } = await renderRoot();
		rerender(
			<StrictMode>
				<FloatingWidgetRoot />
			</StrictMode>
		);
		await act(async () => {});
		expect(ready).toHaveBeenCalledTimes(1);
		expect(ready).toHaveBeenCalledWith('media-player');
	});
});
