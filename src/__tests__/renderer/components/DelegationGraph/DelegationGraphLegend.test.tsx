/**
 * Tests for DelegationGraphLegend - what the lines, badges and borders mean,
 * and how much of each is on the graph.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
	DelegationGraphLegend,
	describeDelegationGraphStats,
} from '../../../../renderer/components/DelegationGraph/DelegationGraphLegend';
import { DELEGATION_EDGE_LINES } from '../../../../renderer/components/DelegationGraph/edges/DelegationEdge';
import { AGENT_DELEGATION_NODE_BORDER_STYLE } from '../../../../renderer/components/DelegationGraph/nodes/AgentDelegationNode';
import type { DelegationGraphStats } from '../../../../shared/delegationGraph';
import { mockTheme } from '../../../helpers/mockTheme';

const STATS: DelegationGraphStats = { agents: 6, edges: 4, mutual: 1, isolated: 2, spill: 1 };

describe('describeDelegationGraphStats', () => {
	it('says how many agents and edges, then what stands out', () => {
		expect(describeDelegationGraphStats(STATS)).toEqual([
			'6 agents, 4 edges',
			'1 mutual pair',
			'2 with no peers',
			'1 outside this scope',
		]);
	});

	it('leaves out a count that is zero', () => {
		expect(
			describeDelegationGraphStats({ agents: 1, edges: 1, mutual: 0, isolated: 0, spill: 0 })
		).toEqual(['1 agent, 1 edge']);
	});

	it('uses the plural for more than one mutual pair', () => {
		expect(describeDelegationGraphStats({ ...STATS, mutual: 3 })).toContain('3 mutual pairs');
	});
});

describe('DelegationGraphLegend', () => {
	const renderLegend = (onClose = vi.fn()) => {
		render(<DelegationGraphLegend theme={mockTheme} stats={STATS} onClose={onClose} />);
		return onClose;
	};

	// The samples come from the table the canvas draws from, so the legend
	// cannot show a line the graph does not use.
	it('draws one sample per kind of edge, with the line and the badge of that kind', () => {
		renderLegend();
		const legend = screen.getByTestId('delegation-graph-legend');

		for (const kind of ['consult', 'delegate', 'both'] as const) {
			const row = legend.querySelector(`li[data-edge-kind="${kind}"]`) as HTMLElement;
			const line = row.querySelector('line') as SVGLineElement;
			expect(line.getAttribute('stroke-width')).toBe(String(DELEGATION_EDGE_LINES[kind].width));
			expect(line.getAttribute('stroke-dasharray')).toBe(DELEGATION_EDGE_LINES[kind].dash ?? null);
			expect(within(row).getByTestId('delegation-edge-badge')).toHaveAttribute(
				'data-edge-kind',
				kind
			);
		}
	});

	it('draws one sample per agent state, with the border of that state', () => {
		renderLegend();
		const legend = screen.getByTestId('delegation-graph-legend');

		for (const state of ['in-scope', 'spill', 'isolated'] as const) {
			const sample = legend.querySelector(`li[data-node-state="${state}"] > span`) as HTMLElement;
			expect(sample.style.borderStyle).toBe(AGENT_DELEGATION_NODE_BORDER_STYLE[state]);
		}
	});

	// The Peers tab writes the two bits as R and W; an edge writes them as C and D.
	it('ties the edge letters to the letters on the Peers tab', () => {
		renderLegend();
		const text = screen.getByTestId('delegation-graph-legend').textContent ?? '';

		expect(text).toMatch(/C is consult, the R box/);
		expect(text).toMatch(/D is delegate,\s*the W box/);
	});

	it('shows the counts', () => {
		renderLegend();
		expect(screen.getByTestId('delegation-graph-stats')).toHaveTextContent('6 agents, 4 edges');
		expect(screen.getByTestId('delegation-graph-stats')).toHaveTextContent('2 with no peers');
	});

	it('closes from its own button', () => {
		const onClose = renderLegend();
		fireEvent.click(screen.getByRole('button', { name: 'Hide the legend' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
