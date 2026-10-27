/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * @fileoverview The Sketch Books list: every sketch across every agent, newest
 * first, searchable, with Open, Rename and Delete going through the same
 * `window.maestro.sketch` channels as `maestro-cli sketch open|rename|delete`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	SketchBooksModal,
	filterSketchBookRows,
	type SketchBookRow,
} from '../../../../renderer/components/SketchBook/SketchBooksModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { SketchRecord } from '../../../../shared/sketch/types';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

function record(overrides: Partial<SketchRecord>): SketchRecord {
	return {
		sketchId: 'sketch-1',
		ownerAgentId: 'agent-1',
		name: 'Untitled Sketch',
		filePath: '/data/sketches/agent-1/sketch-1.excalidraw',
		createdAt: 1,
		share: null,
		guestEdited: false,
		...overrides,
	};
}

const older = record({ sketchId: 'sketch-old', name: 'Architecture', createdAt: 100 });
const newer = record({ sketchId: 'sketch-new', name: 'Release plan', createdAt: 200 });
const shared = record({
	sketchId: 'sketch-shared',
	name: 'Team board',
	createdAt: 50,
	share: { roomId: 'room-1', keyEpoch: 1, links: [], botPolicy: 'conductor' },
});
const orphan = record({
	sketchId: 'sketch-orphan',
	ownerAgentId: 'gone-agent',
	name: 'Lost notes',
	createdAt: 10,
});

const api = {
	list: vi.fn(),
	open: vi.fn(),
	rename: vi.fn(),
	delete: vi.fn(),
};

function renderList(agentId?: string) {
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<SketchBooksModal theme={mockTheme} agentId={agentId} onClose={onClose} />
		</LayerStackProvider>
	);
	return { onClose };
}

const rowNames = () =>
	screen.getAllByTestId('sketch-books-row').map((row) => row.textContent ?? '');

describe('filterSketchBookRows', () => {
	const rows: SketchBookRow[] = [
		{ record: older, ownerName: 'Planner', hasOpenTab: false },
		{ record: newer, ownerName: 'Builder', hasOpenTab: true },
		{ record: orphan, ownerName: null, hasOpenTab: false },
	];

	it('lists newest first with no query', () => {
		expect(filterSketchBookRows(rows, '').map((row) => row.record.sketchId)).toEqual([
			'sketch-new',
			'sketch-old',
			'sketch-orphan',
		]);
	});

	it('matches every word against the name, the owner and the id', () => {
		expect(filterSketchBookRows(rows, 'planner arch').map((row) => row.record.name)).toEqual([
			'Architecture',
		]);
		expect(filterSketchBookRows(rows, 'BUILDER').map((row) => row.record.name)).toEqual([
			'Release plan',
		]);
		expect(filterSketchBookRows(rows, 'sketch-orphan').map((row) => row.record.name)).toEqual([
			'Lost notes',
		]);
		expect(filterSketchBookRows(rows, 'planner release')).toEqual([]);
	});
});

describe('SketchBooksModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.list.mockResolvedValue([older, newer, shared, orphan]);
		api.open.mockResolvedValue({ record: newer, tabId: 'tab-1' });
		api.rename.mockImplementation(async (sketchId: string, name: string) => ({
			...(sketchId === newer.sketchId ? newer : older),
			name,
		}));
		api.delete.mockResolvedValue(undefined);
		const host = window as unknown as { maestro: Record<string, unknown> };
		host.maestro = { ...host.maestro, sketch: api };
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'agent-1',
					name: 'Planner',
					sketchTabs: [{ id: 'tab-a', sketchId: 'sketch-new', name: 'Release plan', createdAt: 1 }],
				}),
			],
		});
	});

	it('lists every sketch newest first, naming the owner or saying it is gone', async () => {
		renderList();
		await screen.findByText('Release plan');

		const rows = rowNames();
		expect(rows[0]).toContain('Release plan');
		expect(rows[0]).toContain('Open');
		expect(rows[1]).toContain('Architecture');
		expect(rows[2]).toContain('Shared');
		expect(rows[3]).toContain('Owner agent removed');
		// No owner filter: every agent's sketches.
		expect(api.list).toHaveBeenCalledWith(undefined);
	});

	it('narrows the list as you type', async () => {
		renderList();
		await screen.findByText('Release plan');

		fireEvent.change(screen.getByLabelText('Search Sketch Books'), {
			target: { value: 'arch' },
		});

		expect(rowNames()).toHaveLength(1);
		expect(rowNames()[0]).toContain('Architecture');
	});

	it('opens the selected sketch on Enter and closes', async () => {
		const { onClose } = renderList();
		await screen.findByText('Release plan');

		fireEvent.keyDown(screen.getByLabelText('Search Sketch Books'), { key: 'Enter' });

		await waitFor(() => expect(api.open).toHaveBeenCalledWith('sketch-new'));
		expect(onClose).toHaveBeenCalled();
	});

	it('cannot open a sketch whose agent is gone, or delete a shared one', async () => {
		renderList();
		await screen.findByText('Lost notes');

		const rows = screen.getAllByTestId('sketch-books-row');
		const openOrphan = rows[3].querySelector('button[title^="The agent that owned it is gone"]');
		expect(openOrphan).toBeDisabled();
		const deleteShared = rows[2].querySelector('button[title^="Shared"]');
		expect(deleteShared).toBeDisabled();
	});

	it('deletes after the confirmation and drops the row', async () => {
		renderList();
		await screen.findByText('Architecture');

		const row = screen.getAllByTestId('sketch-books-row')[1];
		fireEvent.click(row.querySelector('button[title="Delete"]')!);
		fireEvent.click(await screen.findByText('Delete', { selector: 'button' }));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith('sketch-old'));
		await waitFor(() => expect(screen.queryByText('Architecture')).not.toBeInTheDocument());
	});

	it('renames in place and commits once on Enter', async () => {
		renderList();
		await screen.findByText('Architecture');

		const row = screen.getAllByTestId('sketch-books-row')[1];
		fireEvent.click(row.querySelector('button[title="Rename (F2)"]')!);
		const input = screen.getByLabelText('Sketch name');
		fireEvent.change(input, { target: { value: 'System map' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.blur(input);

		await screen.findByText('System map');
		expect(api.rename).toHaveBeenCalledTimes(1);
		expect(api.rename).toHaveBeenCalledWith('sketch-old', 'System map');
	});

	it('Escape clears the search before it closes the list', async () => {
		const { onClose } = renderList();
		await screen.findByText('Release plan');

		const search = screen.getByLabelText('Search Sketch Books');
		fireEvent.change(search, { target: { value: 'arch' } });
		fireEvent.keyDown(window, { key: 'Escape' });

		expect(search).toHaveValue('');
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
	});

	it("lists one agent's sketches, open and closed, when scoped to it", async () => {
		api.list.mockResolvedValue([older, newer]);
		renderList('agent-1');
		await screen.findByText('Release plan');

		expect(api.list).toHaveBeenCalledWith({ ownerAgentId: 'agent-1' });
		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Planner');
		const rows = rowNames();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain('Open');
		expect(rows[1]).toContain('Architecture');
		expect(rows[1]).not.toContain('Open');
		// The header names the agent, so the rows do not repeat it.
		expect(rows[0]).not.toContain('Planner');
	});

	it('names the whole list in the header when unscoped', async () => {
		renderList();
		await screen.findByText('Release plan');
		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('All agents');
	});
});
