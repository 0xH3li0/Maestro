/**
 * @fileoverview Tests for the shared group agent defaults helpers.
 */

import { describe, it, expect } from 'vitest';
import {
	applyGroupDefaultsToSession,
	diffGroupDefaults,
	directGroupMembers,
	groupDefaultsPublishProvider,
	PUBLISHABLE_KEYS,
	publishableChangesFor,
	summarizeGroupDefaultsDiff,
	UNPUBLISHABLE_KEYS,
	withGroupDefaults,
	withGroupShortLabel,
	type GroupDefaultsTarget,
} from '../../shared/groupAgentDefaults';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import type { Group, GroupAgentDefaults } from '../../shared/types';

const group = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Backend',
	emoji: '🌳',
	collapsed: false,
	...overrides,
});

describe('withGroupDefaults', () => {
	it('sets the defaults and carries every other field over', () => {
		const before = group({ shortLabel: 'BE', color: '#9146FF', parentGroupId: 'root' });
		const after = withGroupDefaults(before, { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } });

		expect(after).toEqual({
			...before,
			defaults: { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } },
		});
	});

	it('replaces the defaults a group already holds, whole', () => {
		const before = group({ defaults: { customModel: 'opus', nudgeMessage: 'Be brief.' } });
		expect(withGroupDefaults(before, { nudgeMessage: 'Be thorough.' }).defaults).toEqual({
			nudgeMessage: 'Be thorough.',
		});
	});

	it('removes the field for no defaults, and never stores an empty object', () => {
		const before = group({ shortLabel: 'BE', defaults: { customModel: 'opus' } });

		const cleared = withGroupDefaults(before, undefined);
		expect(cleared).not.toHaveProperty('defaults');
		expect(cleared.shortLabel).toBe('BE');

		expect(withGroupDefaults(before, {})).not.toHaveProperty('defaults');
	});

	it('does not mutate the group it was given', () => {
		const before = group({ defaults: { customModel: 'opus' } });
		withGroupDefaults(before, undefined);
		expect(before.defaults).toEqual({ customModel: 'opus' });
	});
});

describe('withGroupShortLabel', () => {
	it('sets the label and carries every other field over, defaults included', () => {
		const before = group({ color: '#9146FF', defaults: { customModel: 'opus' } });
		expect(withGroupShortLabel(before, 'BE')).toEqual({ ...before, shortLabel: 'BE' });
	});

	it('replaces the label a group already holds', () => {
		expect(withGroupShortLabel(group({ shortLabel: 'BE' }), 'Back').shortLabel).toBe('Back');
	});

	it('trims the label', () => {
		expect(withGroupShortLabel(group(), '  BE  ').shortLabel).toBe('BE');
	});

	it.each([
		['an empty string', ''],
		['whitespace only', '   '],
		['undefined', undefined],
	])('removes the field for %s, and never stores an empty label', (_case, label) => {
		const before = group({ shortLabel: 'BE', defaults: { customModel: 'opus' } });
		const after = withGroupShortLabel(before, label);

		expect(after).not.toHaveProperty('shortLabel');
		expect(after.defaults).toEqual({ customModel: 'opus' });
	});

	it('does not cut a label: the cap is enforced where the label is typed', () => {
		expect(withGroupShortLabel(group(), 'Money-Sessions-2026').shortLabel).toBe(
			'Money-Sessions-2026'
		);
	});

	it('does not mutate the group it was given', () => {
		const before = group({ shortLabel: 'BE' });
		withGroupShortLabel(before, '');
		expect(before.shortLabel).toBe('BE');
	});
});

/** An agent's record, as far as a publish reads it, plus state it must not touch. */
type Agent = GroupDefaultsTarget & {
	id: string;
	name: string;
	groupId?: string;
	aiTabs: { id: string; agentSessionId: string }[];
};

const agent = (overrides: Partial<Agent> = {}): Agent => ({
	id: 'agent-1',
	name: 'Backend',
	toolType: 'claude-code',
	groupId: 'group-1',
	aiTabs: [{ id: 'tab-1', agentSessionId: 'provider-session-1' }],
	...overrides,
});

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'OpenRouter',
	kind: 'openai-compatible',
	baseUrl: 'https://openrouter.ai/api/v1',
	enabled: true,
};
const LOCAL_TARGET = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:4b' };
const CLOUD_TARGET = { type: 'source' as const, endpointId: CLOUD.id, model: 'qwen3-coder' };
const SSH = { enabled: true, remoteId: 'remote-1' };

describe('PUBLISHABLE_KEYS and UNPUBLISHABLE_KEYS', () => {
	it('never publishes the provider, the working directory or the SSH remote', () => {
		expect(UNPUBLISHABLE_KEYS).toEqual(['projectRoot', 'toolType', 'sessionSshRemoteConfig']);
	});

	it('puts every default in exactly one list', () => {
		for (const key of UNPUBLISHABLE_KEYS) expect(PUBLISHABLE_KEYS).not.toContain(key);
		// The full key list of `GroupAgentDefaults`, counted by hand: 29.
		expect(PUBLISHABLE_KEYS.length + UNPUBLISHABLE_KEYS.length).toBe(29);
	});

	it('does not list the pill label: it is not a default', () => {
		expect([...PUBLISHABLE_KEYS, ...UNPUBLISHABLE_KEYS]).not.toContain('shortLabel');
	});
});

describe('diffGroupDefaults', () => {
	it('finds added, changed and removed keys, with each side of the save', () => {
		const diff = diffGroupDefaults(
			{ customModel: 'sonnet', nudgeMessage: 'Be brief.', toolType: 'claude-code' },
			{ customModel: 'opus', newSessionMessage: 'Read the docs.', toolType: 'claude-code' }
		);

		expect(diff.changes).toEqual([
			{ key: 'newSessionMessage', before: undefined, after: 'Read the docs.' },
			{ key: 'nudgeMessage', before: 'Be brief.', after: undefined },
			{ key: 'customModel', before: 'sonnet', after: 'opus' },
		]);
		expect(diff.provider).toEqual({ before: 'claude-code', after: 'claude-code' });
	});

	it('breaks env vars out per key, set and removed', () => {
		const diff = diffGroupDefaults(
			{ customEnvVars: { KEEP: '1', CHANGE: 'old', DROP: 'x' } },
			{ customEnvVars: { KEEP: '1', CHANGE: 'new', ADD: 'y' } }
		);

		expect(diff.changes.map((change) => change.key)).toEqual(['customEnvVars']);
		expect(diff.envVars).toEqual({ set: { CHANGE: 'new', ADD: 'y' }, removed: ['DROP'] });
		expect(diff.envVarsDisabled).toEqual({ set: {}, removed: [] });
	});

	it('breaks tier targets out per tier', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code', tierTargets: { low: { type: 'provider-model', model: 'haiku' } } },
			{ toolType: 'claude-code', tierTargets: { high: { type: 'provider-model', model: 'opus' } } }
		);

		expect(diff.tierTargets).toEqual({
			set: { high: { type: 'provider-model', model: 'opus' } },
			removed: ['low'],
		});
	});

	it('is empty for the same profile, whatever the key order', () => {
		const before: GroupAgentDefaults = {
			customModel: 'opus',
			customEnvVars: { A: '1', B: '2' },
			peerAgents: [{ sessionId: 'a', read: true, write: false }],
		};
		const after: GroupAgentDefaults = {
			peerAgents: [{ sessionId: 'a', write: false, read: true }],
			customEnvVars: { B: '2', A: '1' },
			customModel: 'opus',
		};

		expect(diffGroupDefaults(before, after).changes).toEqual([]);
		expect(diffGroupDefaults(undefined, undefined).changes).toEqual([]);
		expect(diffGroupDefaults(undefined, {}).changes).toEqual([]);
	});

	it('is empty for a save that changed only the pill label, and reaches no agent', () => {
		const before = group({ shortLabel: 'BE', defaults: { customModel: 'opus' } });
		const after = withGroupShortLabel(before, 'API');
		const diff = diffGroupDefaults(before.defaults, after.defaults);

		expect(diff.changes).toEqual([]);
		const target = agent({ customModel: 'sonnet' });
		const result = applyGroupDefaultsToSession(target, diff);
		expect(result.next).toBe(target);
		expect(result.undo).toEqual({});
	});
});

describe('publishableChangesFor', () => {
	it('drops the unpublishable keys', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code', projectRoot: '/a' },
			{ toolType: 'codex', projectRoot: '/b', nudgeMessage: 'Be brief.' }
		);
		expect(publishableChangesFor('codex', diff).map((change) => change.key)).toEqual([
			'nudgeMessage',
		]);
	});

	it('hands a provider-bound value only to agents on the profile provider', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' }
		);
		expect(publishableChangesFor('claude-code', diff).map((change) => change.key)).toEqual([
			'nudgeMessage',
			'customModel',
		]);
		expect(publishableChangesFor('codex', diff).map((change) => change.key)).toEqual([
			'nudgeMessage',
		]);
		expect(groupDefaultsPublishProvider(diff)).toBe('claude-code');
	});

	it('removes a provider-bound value from the agents it was written for', () => {
		// The group went back to no default provider: the model leaves with it.
		const diff = diffGroupDefaults({ toolType: 'claude-code', customModel: 'opus' }, {});
		expect(publishableChangesFor('claude-code', diff).map((change) => change.key)).toEqual([
			'customModel',
		]);
		expect(publishableChangesFor('codex', diff)).toEqual([]);
		expect(groupDefaultsPublishProvider(diff)).toBe('claude-code');
	});

	it('removes nothing from anyone when the save moved to another provider', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code', customModel: 'opus', maestroPPath: '/bin/maestro-p' },
			{ toolType: 'codex', customModel: 'gpt-5' }
		);
		// The new provider's model reaches its own agents, and nobody else.
		expect(publishableChangesFor('codex', diff).map((change) => change.key)).toEqual([
			'customModel',
		]);
		expect(publishableChangesFor('claude-code', diff)).toEqual([]);
	});
});

describe('summarizeGroupDefaultsDiff', () => {
	it('names fields by label and variables by their own name', () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{ toolType: 'claude-code' },
				{
					toolType: 'claude-code',
					customModel: 'opus',
					customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' },
					groupPeerAccess: { read: true, write: false },
				}
			)
		);

		expect(summary.changed).toEqual(['Model', 'CLAUDE_CONFIG_DIR', 'Peers in my group']);
		expect(summary.providerBound).toEqual(['Model']);
		expect(summary.unpublished).toEqual([]);
		expect(summary.replaced).toEqual([]);
	});

	it('lists the provider, the working directory and the SSH remote as not published', () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{},
				{
					toolType: 'codex',
					projectRoot: '/srv/app',
					sessionSshRemoteConfig: SSH,
					nudgeMessage: 'Be brief.',
				}
			)
		);

		expect(summary.unpublished).toEqual(['Working Directory', 'Provider', 'SSH Remote']);
		expect(summary.changed).toEqual(['Nudge Message']);
	});

	it('says which changes replace a list', () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{},
				{
					additionalDirectories: [{ path: '/srv/shared', read: true, write: false }],
					peerAgents: [{ sessionId: 'a', read: true, write: false }],
				}
			)
		);
		expect(summary.replaced).toEqual(['Additional Directories', 'Peer Agents']);
	});

	it('names a variable once when the save switched it off', () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{ customEnvVars: { DEBUG: '1' } },
				{ customEnvVarsDisabled: { DEBUG: '1' } }
			)
		);
		expect(summary.changed).toEqual(['DEBUG']);
	});

	it("puts the old provider's dropped values under not published", () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{ toolType: 'claude-code', maestroPPath: '/bin/maestro-p' },
				{ toolType: 'codex' }
			)
		);
		expect(summary.unpublished).toEqual(['Provider', 'maestro-p Path']);
		expect(summary.changed).toEqual([]);
	});

	it('names a tier by its tier', () => {
		const summary = summarizeGroupDefaultsDiff(
			diffGroupDefaults(
				{ toolType: 'claude-code' },
				{
					toolType: 'claude-code',
					tierTargets: { low: { type: 'provider-model', model: 'haiku' } },
				}
			)
		);
		expect(summary.changed).toEqual(['Tier: low']);
	});
});

describe('directGroupMembers', () => {
	it('returns the agents in the group, and never descends into a child group', () => {
		const agents = [
			agent({ id: 'a', groupId: 'group-1' }),
			agent({ id: 'b', groupId: 'child-of-group-1' }),
			agent({ id: 'c', groupId: undefined }),
			agent({ id: 'd', groupId: 'group-1' }),
		];
		expect(directGroupMembers(agents, 'group-1').map((member) => member.id)).toEqual(['a', 'd']);
	});
});

describe('applyGroupDefaultsToSession', () => {
	it('writes only what the save changed', () => {
		// The profile has held `opus` for a week. This save touches the nudge only.
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code', customModel: 'opus' },
			{ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' }
		);
		const target = agent({ customModel: 'sonnet' });

		const { next, undo } = applyGroupDefaultsToSession(target, diff);

		expect(next.nudgeMessage).toBe('Be brief.');
		// Retuned by hand since, and not in this save: left alone.
		expect(next.customModel).toBe('sonnet');
		expect(undo).toEqual({ nudgeMessage: undefined });
	});

	it('never writes the provider, the working directory or the SSH remote', () => {
		const diff = diffGroupDefaults(
			{},
			{
				toolType: 'codex',
				projectRoot: '/srv/other',
				sessionSshRemoteConfig: SSH,
				nudgeMessage: 'Be brief.',
			}
		);
		const target = agent({ projectRoot: '/srv/app' });

		const { next, undo } = applyGroupDefaultsToSession(target, diff);

		expect(next.toolType).toBe('claude-code');
		expect(next.projectRoot).toBe('/srv/app');
		expect(next.sessionSshRemoteConfig).toBeUndefined();
		expect(next.nudgeMessage).toBe('Be brief.');
		expect(Object.keys(undo)).toEqual(['nudgeMessage']);
	});

	it('removes a value the save removed from the profile', () => {
		const diff = diffGroupDefaults({ nudgeMessage: 'Be brief.' }, {});
		const { next, undo } = applyGroupDefaultsToSession(agent({ nudgeMessage: 'Mine.' }), diff);

		expect(next.nudgeMessage).toBeUndefined();
		expect(undo).toEqual({ nudgeMessage: 'Mine.' });
	});

	it("merges env vars by key and leaves the agent's own keys alone", () => {
		const diff = diffGroupDefaults(
			{ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.old', DROP: 'x' } },
			{ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } }
		);
		const target = agent({
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.mine', DROP: 'x', OWN: 'kept' },
		});

		const { next, undo } = applyGroupDefaultsToSession(target, diff);

		expect(next.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '~/.work', OWN: 'kept' });
		expect(undo).toEqual({
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.mine', DROP: 'x', OWN: 'kept' },
		});
		// The agent's record was not mutated.
		expect(target.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '~/.mine', DROP: 'x', OWN: 'kept' });
	});

	it('keeps a variable in exactly one of the two env records', () => {
		// The agent parked DEBUG by hand; the group now sets it live.
		const setLive = diffGroupDefaults({}, { customEnvVars: { DEBUG: '1' } });
		const parked = agent({ customEnvVarsDisabled: { DEBUG: '0', OTHER: 'x' } });
		const live = applyGroupDefaultsToSession(parked, setLive).next;
		expect(live.customEnvVars).toEqual({ DEBUG: '1' });
		expect(live.customEnvVarsDisabled).toEqual({ OTHER: 'x' });

		// The group switches a variable off: it leaves the agent's live record.
		const switchOff = diffGroupDefaults(
			{ customEnvVars: { DEBUG: '1' } },
			{ customEnvVarsDisabled: { DEBUG: '1' } }
		);
		const off = applyGroupDefaultsToSession(agent({ customEnvVars: { DEBUG: '1' } }), switchOff);
		expect(off.next.customEnvVars).toBeUndefined();
		expect(off.next.customEnvVarsDisabled).toEqual({ DEBUG: '1' });
	});

	it('returns an undo that restores exactly the fields it touched', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code', customEnvVars: { A: '1' } },
			{
				toolType: 'claude-code',
				customModel: 'opus',
				customEnvVars: { A: '2' },
				groupPeerAccess: { read: true, write: false },
			}
		);
		const target = agent({ customModel: 'sonnet', customEnvVars: { A: '0', OWN: 'x' } });

		const { next, undo } = applyGroupDefaultsToSession(target, diff);

		expect(Object.keys(undo).sort()).toEqual(['customEnvVars', 'customModel', 'groupPeerAccess']);
		expect({ ...next, ...undo }).toEqual(target);
	});

	it('touches no tab, and returns the same agent when nothing changed', () => {
		const diff = diffGroupDefaults({}, { nudgeMessage: 'Be brief.' });
		const target = agent();

		const changed = applyGroupDefaultsToSession(target, diff).next;
		expect(changed.aiTabs).toBe(target.aiTabs);
		expect(changed.id).toBe(target.id);
		expect(changed.groupId).toBe(target.groupId);

		// An agent that already holds the value is not written at all.
		const same = agent({ nudgeMessage: 'Be brief.' });
		const result = applyGroupDefaultsToSession(same, diff);
		expect(result.next).toBe(same);
		expect(result.undo).toEqual({});
	});

	it('gives a provider-bound value only to an agent on that provider', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' }
		);
		const codex = agent({ toolType: 'codex', customModel: 'gpt-5' });

		const { next } = applyGroupDefaultsToSession(codex, diff);

		expect(next.customModel).toBe('gpt-5');
		expect(next.nudgeMessage).toBe('Be brief.');
	});

	it('replaces a list whole', () => {
		const diff = diffGroupDefaults(
			{},
			{ peerAgents: [{ sessionId: 'docs', read: true, write: false }] }
		);
		const target = agent({ peerAgents: [{ sessionId: 'triage', read: true, write: true }] });

		expect(applyGroupDefaultsToSession(target, diff).next.peerAgents).toEqual([
			{ sessionId: 'docs', read: true, write: false },
		]);
	});

	it('merges tier targets by tier', () => {
		const diff = diffGroupDefaults(
			{
				toolType: 'claude-code',
				tierTargets: { medium: { type: 'provider-model', model: 'old' } },
			},
			{ toolType: 'claude-code', tierTargets: { low: { type: 'provider-model', model: 'haiku' } } }
		);
		const target = agent({
			tierTargets: {
				medium: { type: 'provider-model', model: 'sonnet' },
				high: { type: 'provider-model', model: 'opus' },
			},
		});

		expect(applyGroupDefaultsToSession(target, diff).next.tierTargets).toEqual({
			low: { type: 'provider-model', model: 'haiku' },
			high: { type: 'provider-model', model: 'opus' },
		});
	});

	it('stamps a published context window as a deliberate choice', () => {
		const set = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', customContextWindow: 1_000_000 }
		);
		const stamped = applyGroupDefaultsToSession(agent(), set).next;
		expect(stamped.customContextWindow).toBe(1_000_000);
		expect(stamped.contextWindowSource).toBe('user-edited');

		const removed = diffGroupDefaults(
			{ toolType: 'claude-code', customContextWindow: 1_000_000 },
			{ toolType: 'claude-code' }
		);
		const cleared = applyGroupDefaultsToSession(stamped, removed).next;
		expect(cleared.customContextWindow).toBeUndefined();
		expect(cleared.contextWindowSource).toBeUndefined();
	});

	it('takes the proxy mode off an agent whose gateway is replaced', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', gatewayUrl: 'http://127.0.0.1:8787' }
		);
		const target = agent({
			gatewayUrl: 'http://127.0.0.1:48123/anthropic',
			tokenProxyMode: 'compress',
		});

		const { next, undo } = applyGroupDefaultsToSession(target, diff);

		expect(next.gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(next.tokenProxyMode).toBeUndefined();
		expect(undo).toEqual({
			gatewayUrl: 'http://127.0.0.1:48123/anthropic',
			tokenProxyMode: 'compress',
		});
	});

	it('hands the token proxy fields back to the caller and does not write them', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', tokenProxyMode: 'compress' }
		);
		const target = agent();

		const result = applyGroupDefaultsToSession(target, diff);

		expect(result.proxy).toEqual({ mode: 'compress' });
		// The proxy's address is not a stored value: nothing was written here.
		expect(result.next).toBe(target);

		const off = diffGroupDefaults(
			{ toolType: 'claude-code', tokenProxyMode: 'compress' },
			{ toolType: 'claude-code' }
		);
		expect(applyGroupDefaultsToSession(target, off).proxy).toEqual({ mode: 'off' });
		// An agent on another provider is not sent to the proxy.
		expect(applyGroupDefaultsToSession(agent({ toolType: 'codex' }), diff).proxy).toBeUndefined();
	});

	it("skips a Run on target the agent's SSH remote cannot reach, and says why", () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', runOn: LOCAL_TARGET, nudgeMessage: 'Be brief.' }
		);
		const context = { endpoints: [OLLAMA, CLOUD] };

		const remote = applyGroupDefaultsToSession(
			agent({ sessionSshRemoteConfig: SSH }),
			diff,
			context
		);
		expect(remote.next.runOn).toBeUndefined();
		expect(remote.skipped).toEqual([
			{ label: 'Run On', reason: expect.stringContaining('SSH remote') },
		]);
		// The rest of the save still reaches it.
		expect(remote.next.nudgeMessage).toBe('Be brief.');

		// The same target on this machine is written.
		const local = applyGroupDefaultsToSession(agent(), diff, context);
		expect(local.next.runOn).toEqual(LOCAL_TARGET);
		expect(local.skipped).toEqual([]);
	});

	it('writes a Run on target the remote can reach', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', runOn: CLOUD_TARGET }
		);
		const result = applyGroupDefaultsToSession(agent({ sessionSshRemoteConfig: SSH }), diff, {
			endpoints: [OLLAMA, CLOUD],
		});
		expect(result.next.runOn).toEqual(CLOUD_TARGET);
		expect(result.skipped).toEqual([]);
	});

	it('skips an unreachable tier and still writes the others', () => {
		const diff = diffGroupDefaults(
			{ toolType: 'claude-code' },
			{
				toolType: 'claude-code',
				tierTargets: { low: LOCAL_TARGET, high: { type: 'provider-model', model: 'opus' } },
			}
		);
		const result = applyGroupDefaultsToSession(agent({ sessionSshRemoteConfig: SSH }), diff, {
			endpoints: [OLLAMA],
		});

		expect(result.next.tierTargets).toEqual({ high: { type: 'provider-model', model: 'opus' } });
		expect(result.skipped.map((skip) => skip.label)).toEqual(['Tier: low']);
	});
});
