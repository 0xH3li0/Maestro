/**
 * Group agent defaults: the values a new agent created in a group starts with.
 *
 * The defaults are copy-at-create. They are stamped into the create-agent form
 * and never read again, so nothing here is a runtime layer and no spawn path
 * may import this module to resolve a setting.
 *
 * Shared, not renderer-only, so the desktop and `maestro-cli` write a group's
 * defaults the same way.
 *
 * `withGroupShortLabel` is here too, because Group Settings writes it in the
 * same save. It is NOT a default: a pill label is a property of the group, it
 * never reaches an agent, and it is no part of a defaults diff or a publish.
 */

import type { Group, GroupAgentDefaults } from './types';

/**
 * `group` with its defaults replaced. `undefined` removes the field, so a group
 * with no opinion stores no `defaults` key at all, never an empty object: the
 * create form reads "has defaults" as "show the pre-filled banner".
 *
 * Every other field of the group is carried over, `shortLabel` included.
 */
export function withGroupDefaults(group: Group, defaults: GroupAgentDefaults | undefined): Group {
	const { defaults: _previous, ...rest } = group;
	return defaults && Object.keys(defaults).length > 0 ? { ...rest, defaults } : rest;
}

/**
 * `group` with its pill label (`shortLabel`) replaced. The label is trimmed,
 * and a blank one removes the field, so the automatic abbreviation comes back
 * and a group never stores `''`.
 *
 * The label is not cut here. `GROUP_SHORT_LABEL_MAX_LENGTH` is enforced where a
 * label is typed (the Group Settings input, the CLI flag), where the user can
 * see the cap. Read the label back with `groupBadgeLabel()`.
 */
export function withGroupShortLabel(group: Group, shortLabel: string | undefined): Group {
	const { shortLabel: _previous, ...rest } = group;
	const label = shortLabel?.trim();
	return label ? { ...rest, shortLabel: label } : rest;
}
