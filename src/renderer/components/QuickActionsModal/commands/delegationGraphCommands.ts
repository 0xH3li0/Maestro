import type { QuickAction } from '../types';
import { useModalStore } from '../../../stores/modalStore';

interface BuildDelegationGraphCommandsArgs {
	setQuickActionOpen: (open: boolean) => void;
	/** Ships unbound, so this is a chord only once the user binds one. */
	openDelegationGraphShortcut?: QuickAction['shortcut'];
}

/**
 * The palette's way into the Delegation Graph: the fleet's peer relationships,
 * drawn. Opens on every agent, the same as the menu item and the hotkey.
 */
export function buildDelegationGraphCommands({
	setQuickActionOpen,
	openDelegationGraphShortcut,
}: BuildDelegationGraphCommandsArgs): QuickAction[] {
	return [
		{
			id: 'openDelegationGraph',
			label: 'Delegation Graph',
			subtext: 'See which agent can consult or delegate to which',
			shortcut: openDelegationGraphShortcut,
			action: () => {
				setQuickActionOpen(false);
				useModalStore.getState().openModal('delegationGraph');
			},
		},
	];
}
