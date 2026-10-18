import { describe, it, expect, beforeEach } from 'vitest';
import { filterPoppedOutRefs } from '../../../renderer/utils/unifiedTabOrderUtils';
import { useTabWindowStore } from '../../../renderer/stores/tabWindowStore';
import type { UnifiedTabRef } from '../../../renderer/types';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';

const order: UnifiedTabRef[] = [
	{ type: 'ai', id: 'a1' },
	{ type: 'file', id: 'f1' },
	{ type: 'group', id: 'g1' },
	{ type: 'terminal', id: 't1' },
	{ type: 'browser', id: 'b1' },
];

function popOut(agentId: string, tabRefs: TabWindowTabRef[]) {
	useTabWindowStore
		.getState()
		.setWindows([{ windowId: 'tw-1', agentId, tabRefs, activeTabRef: tabRefs[0] ?? null }]);
}

describe('filterPoppedOutRefs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	it('returns the input by reference when nothing is popped out', () => {
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('returns the input by reference when the popped tabs are not in the order', () => {
		popOut('agent-a', [{ type: 'ai', id: 'elsewhere' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('returns the input by reference when another agent has the popped tab', () => {
		popOut('agent-b', [{ type: 'ai', id: 'a1' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('drops popped refs of every tab type and keeps the rest in order', () => {
		popOut('agent-a', [
			{ type: 'ai', id: 'a1' },
			{ type: 'terminal', id: 't1' },
			{ type: 'browser', id: 'b1' },
		]);
		expect(filterPoppedOutRefs('agent-a', order)).toEqual([
			{ type: 'file', id: 'f1' },
			{ type: 'group', id: 'g1' },
		]);
	});

	it('matches on type and id', () => {
		popOut('agent-a', [{ type: 'file', id: 'a1' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('never drops a group ref', () => {
		popOut('agent-a', [{ type: 'file', id: 'f1' }]);
		const groupOnly: UnifiedTabRef[] = [{ type: 'group', id: 'f1' }];
		expect(filterPoppedOutRefs('agent-a', groupOnly)).toBe(groupOnly);
	});

	it('does not mutate the stored order', () => {
		popOut('agent-a', [{ type: 'ai', id: 'a1' }]);
		const stored = [...order];
		filterPoppedOutRefs('agent-a', stored);
		expect(stored).toEqual(order);
	});
});
