import React from 'react';
import type { Group, Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal } from '../ui';

export interface GroupSettingsModalProps {
	theme: Theme;
	/** The group whose defaults for new agents are edited. */
	group: Group;
	/** The store's group write. A save goes through it and through nothing else. */
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	onClose: () => void;
}

/**
 * Group Settings: the values a new agent created in one group starts with.
 *
 * The defaults are copy-at-create. They are stamped into the create-agent form
 * and never read again, so nothing here is a runtime layer. The explainer says
 * so to the user, because a group setting reads like one that applies live.
 */
export function GroupSettingsModal({ theme, group, onClose }: GroupSettingsModalProps) {
	return (
		<Modal
			theme={theme}
			title={`Group Settings: ${group.emoji} ${group.name}`}
			priority={MODAL_PRIORITIES.GROUP_SETTINGS}
			onClose={onClose}
			resizable
			resizeKey="group-settings"
			defaultSize={{ width: 720, height: 640 }}
			minSize={{ width: 560, height: 420 }}
			contentClassName="flex flex-col flex-1 min-h-0"
			testId="group-settings-modal"
		>
			<div
				className="mx-6 mt-4 p-3 rounded border text-xs space-y-2 select-text"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textDim,
				}}
				data-testid="group-settings-explainer"
			>
				<p>
					These are the starting values for{' '}
					<strong style={{ color: theme.colors.textMain }}>new</strong> agents created in this
					group. When you add an agent here, the create-agent form opens with everything below
					already filled in, and you can change any of it before, or after, the agent is created.
				</p>
				<p>
					Nothing here is read while an agent runs. Every agent keeps its own settings, and moving
					an agent into this group does not change it. When you save a change, Maestro asks whether
					to publish that change to the agents already in this group, or to keep it for new agents
					only. Leave a field blank to use the Maestro default.
				</p>
			</div>
		</Modal>
	);
}
