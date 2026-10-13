/**
 * Group agent defaults: the values a new agent created in a group starts with.
 *
 * The defaults are copy-at-create. They are stamped into the create-agent form
 * and never read again, so nothing here is a runtime layer and no spawn path
 * may import this module to resolve a setting.
 *
 * Shared, not renderer-only, so the desktop and `maestro-cli` write a group's
 * defaults the same way.
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
