/**
 * @file cue-control.test.ts
 * @description Tests for `cue enable|disable|activity`: name resolution
 * (refusing an ambiguous name), the toggle message, and error-frame handling.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));

import {
	cueActivity,
	cueDisable,
	cueEnable,
	resolveSubscription,
} from '../../../cli/commands/cue-control';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const subs = [
	{
		id: 'a1::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: true,
	},
	{
		id: 'a2::p::nightly',
		name: 'nightly',
		eventType: 'time.scheduled',
		sessionId: 'a2',
		sessionName: 'Two',
		enabled: true,
	},
	{
		id: 'a1::p::on-pr',
		name: 'on-pr',
		eventType: 'github.pull_request',
		sessionId: 'a1',
		sessionName: 'One',
		enabled: false,
	},
];

function mockBridge(responses: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				sent.push(payload);
				return Promise.resolve(responses[payload.type as string]);
			}),
		} as never)
	);
	return sent;
}

describe('resolveSubscription', () => {
	it('matches a full id, a unique name, or a name narrowed by agent', () => {
		expect(resolveSubscription(subs, 'a2::p::nightly').sessionId).toBe('a2');
		expect(resolveSubscription(subs, 'on-pr').id).toBe('a1::p::on-pr');
		expect(resolveSubscription(subs, 'nightly', 'a2').id).toBe('a2::p::nightly');
	});

	it('refuses a name several agents share, and an unknown name', () => {
		expect(() => resolveSubscription(subs, 'nightly')).toThrow(/names 2 subscriptions/);
		expect(() => resolveSubscription(subs, 'nope')).toThrow(/No Cue subscription/);
	});
});

describe('cue enable/disable/activity', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('enable sends the resolved id with enabled:true', async () => {
		const sent = mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: true },
		});
		await cueEnable('on-pr', {});
		expect(sent[1]).toEqual({
			type: 'toggle_cue_subscription',
			subscriptionId: 'a1::p::on-pr',
			enabled: true,
		});
	});

	it('disable exits non-zero when the engine reports failure', async () => {
		mockBridge({
			get_cue_subscriptions: { subscriptions: subs },
			toggle_cue_subscription: { type: 'toggle_cue_subscription_result', success: false },
		});
		await expect(cueDisable('on-pr', {})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('activity passes agent and limit, and fails on an error frame', async () => {
		const sent = mockBridge({ get_cue_activity: { type: 'cue_activity', entries: [] } });
		await cueActivity({ agent: 'a1', limit: '5' });
		expect(sent[0]).toEqual({ type: 'get_cue_activity', sessionId: 'a1', limit: 5 });

		mockBridge({ get_cue_activity: { type: 'error', message: 'Cue activity not available' } });
		await expect(cueActivity({})).rejects.toThrow('__exit__');
	});

	it('activity prints why a gate skipped an event', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBridge({
			get_cue_activity: {
				type: 'cue_activity',
				entries: [
					{
						id: 'r1',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:00:00Z'),
						status: 'gated',
						result: 'The comment is praise and asks for nothing.',
						duration: 40,
					},
					{
						id: 'r2',
						subscriptionId: 'a1::p::on-pr',
						subscriptionName: 'on-pr',
						eventType: 'github.issue',
						sessionId: 'a1',
						timestamp: Date.parse('2026-10-11T12:01:00Z'),
						status: 'completed',
						result: 'Opened a fix.',
						duration: 9000,
					},
				],
			},
		});

		await cueActivity({});

		const lines = logSpy.mock.calls.map((call) => String(call[0]));
		expect(lines[0]).toMatch(/gated\s+on-pr\s+\[github\.issue\]/);
		expect(lines[0]).toContain('- The comment is praise and asks for nothing.');
		// A run's output is not echoed on the one-line form.
		expect(lines[1]).toMatch(/completed\s+on-pr/);
		expect(lines[1]).not.toContain('Opened a fix.');
	});

	it('activity rejects a bad --limit before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueActivity({ limit: 'lots' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});
});
