/**
 * @fileoverview Tests for PeersTab, the placeholder until Peer Agents lands.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PeersTab } from '../../../../renderer/components/AgentSettings/PeersTab';
import { createMockTheme } from '../../../helpers/mockTheme';

describe('PeersTab', () => {
	it('is the peers tabpanel and says where Peer Agents are set up', () => {
		render(<PeersTab theme={createMockTheme()} idPrefix="edit-agent" />);
		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-peers');
		expect(screen.getByText('Peer Agents are set up here.')).toBeInTheDocument();
	});
});
