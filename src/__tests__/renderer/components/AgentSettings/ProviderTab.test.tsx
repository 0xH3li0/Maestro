/**
 * @fileoverview Tests for ProviderTab: the picker slot, Agent Resilience and
 * the chain of thought export slot.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderTab } from '../../../../renderer/components/AgentSettings/ProviderTab';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();

describe('ProviderTab', () => {
	it('renders the picker first, then resilience, then the export slot', () => {
		render(
			<ProviderTab
				theme={theme}
				idPrefix="new-agent"
				picker={<div data-testid="picker-slot">picker</div>}
				resilience={{
					retryOnAvailabilityErrors: true,
					retryOnTokenExhaustion: false,
					onChangeAvailability: vi.fn(),
					onChangeTokenExhaustion: vi.fn(),
				}}
				cotExport={<div data-testid="cot-slot">cot</div>}
			/>
		);

		const panel = screen.getByRole('tabpanel');
		expect(panel).toHaveAttribute('id', 'new-agent-tabpanel-provider');
		const picker = screen.getByTestId('picker-slot');
		const resilience = screen.getByText('Agent Resilience');
		const cot = screen.getByTestId('cot-slot');
		expect(
			picker.compareDocumentPosition(resilience) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(resilience.compareDocumentPosition(cot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('reports resilience changes to the modal', () => {
		const onChangeAvailability = vi.fn();
		render(
			<ProviderTab
				theme={theme}
				idPrefix="edit-agent"
				picker={null}
				resilience={{
					retryOnAvailabilityErrors: true,
					retryOnTokenExhaustion: true,
					onChangeAvailability,
					onChangeTokenExhaustion: vi.fn(),
				}}
			/>
		);

		fireEvent.click(screen.getByLabelText('Retry on availability errors'));
		expect(onChangeAvailability).toHaveBeenCalledWith(false);
	});

	it('omits resilience when the surface has none', () => {
		render(<ProviderTab theme={theme} idPrefix="group-chat" picker={<div>picker</div>} />);
		expect(screen.queryByText('Agent Resilience')).not.toBeInTheDocument();
	});
});
