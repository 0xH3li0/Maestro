import { describe, expect, it, vi } from 'vitest';
import { buildSketchBookCommands } from '../sketchBookCommands';
import { createMockSession } from '../../../../../__tests__/helpers/mockSession';

function build(overrides: Partial<Parameters<typeof buildSketchBookCommands>[0]> = {}) {
	return buildSketchBookCommands({
		sketchBookAvailable: true,
		activeSession: createMockSession({ id: 'agent-1', name: 'Planner' }),
		newSketchBook: vi.fn(),
		showSketchBooks: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	});
}

describe('buildSketchBookCommands', () => {
	it('offers nothing while Sketch Book is unavailable (flag off or web-desktop)', () => {
		expect(build({ sketchBookAvailable: false })).toEqual([]);
	});

	it('offers only the Sketch Books list without an active agent to own a new sketch', () => {
		expect(build({ activeSession: undefined }).map((command) => command.id)).toEqual([
			'showSketchBooks',
		]);
	});

	it('offers "Sketch Books" with its chord, opening the list and dismissing the palette', () => {
		const showSketchBooks = vi.fn();
		const setQuickActionOpen = vi.fn();
		const shortcut = {
			id: 'showSketchBooks',
			label: 'Show Sketch Books',
			keys: ['Alt', 'Meta', 'Shift', 'k'],
		};
		const command = build({
			showSketchBooks,
			setQuickActionOpen,
			showSketchBooksShortcut: shortcut,
		}).find((candidate) => candidate.id === 'showSketchBooks')!;
		expect(command.label).toBe('Sketch Books');
		expect(command.shortcut).toBe(shortcut);

		command.action();

		expect(showSketchBooks).toHaveBeenCalled();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers "New Sketch Book" with its chord and the owning agent', () => {
		const shortcut = { id: 'newSketchBook', label: 'New Sketch Book', keys: ['Alt', 'Meta', 'k'] };
		const [command] = build({ newSketchBookShortcut: shortcut });
		expect(command.id).toBe('newSketchBook');
		expect(command.label).toBe('New Sketch Book');
		expect(command.shortcut).toBe(shortcut);
		expect(command.subtext).toContain('Planner');
	});

	it('creates the sketch for the active agent and dismisses the palette', () => {
		const newSketchBook = vi.fn();
		const setQuickActionOpen = vi.fn();
		const [command] = build({ newSketchBook, setQuickActionOpen });

		command.action();

		expect(newSketchBook).toHaveBeenCalledWith('agent-1');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});
