// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/cue-control.test.ts
//   - src/__tests__/cli/commands/marketplace.test.ts

import {
	cueActivity,
	cueDisable,
	cueEnable,
	resolveSubscription,
} from '../../../cli/commands/cue-control';
import {
	filterPlaybooks,
	marketplaceImport,
	marketplaceList,
} from '../../../cli/commands/marketplace';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MarketplacePlaybook } from '../../../shared/marketplace-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));

// ===== from src/__tests__/cli/commands/cue-control.test.ts =====

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

	it('activity rejects a bad --limit before connecting', async () => {
		const sent = mockBridge({});
		await expect(cueActivity({ limit: 'lots' })).rejects.toThrow('__exit__');
		expect(sent).toHaveLength(0);
	});
});

// ===== from src/__tests__/cli/commands/marketplace.test.ts =====

const pb = (over: Partial<MarketplacePlaybook>): MarketplacePlaybook =>
	({
		id: 'x',
		title: 'X',
		description: '',
		category: 'Development',
		author: 'a',
		lastUpdated: '2026-01-01',
		path: 'dev/x',
		documents: [{ filename: 'one', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: null,
		...over,
	}) as MarketplacePlaybook;

const catalog = [
	pb({ id: 'security-audit', title: 'Security Audit', category: 'Security', tags: ['owasp'] }),
	pb({ id: 'docs-pass', title: 'Docs Pass', description: 'tighten the README' }),
];

function mockBridge_1(responses: Record<string, unknown>) {
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

describe('filterPlaybooks', () => {
	it('filters by category and by a search over id, title, description, and tags', () => {
		expect(filterPlaybooks(catalog, { category: 'security' }).map((p) => p.id)).toEqual([
			'security-audit',
		]);
		expect(filterPlaybooks(catalog, { search: 'OWASP' }).map((p) => p.id)).toEqual([
			'security-audit',
		]);
		expect(filterPlaybooks(catalog, { search: 'readme' }).map((p) => p.id)).toEqual(['docs-pass']);
	});
});

describe('marketplace commands', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('list passes --refresh through and fails when the catalog does not load', async () => {
		const sent = mockBridge_1({
			marketplace_get_manifest: {
				success: true,
				manifest: { lastUpdated: '', playbooks: catalog },
			},
		});
		await marketplaceList({ refresh: true });
		expect(sent[0]).toEqual({ type: 'marketplace_get_manifest', refresh: true });

		mockBridge_1({ marketplace_get_manifest: { success: false, error: 'offline' } });
		await expect(marketplaceList({})).rejects.toThrow('__exit__');
	});

	it('import defaults the folder to the slug the modal proposes', async () => {
		const sent = mockBridge_1({
			marketplace_get_manifest: {
				success: true,
				manifest: { lastUpdated: '', playbooks: catalog },
			},
			marketplace_import_playbook: { success: true, importedDocs: ['one'] },
		});
		await marketplaceImport('security-audit', { agent: 'a1' });
		expect(sent[1]).toEqual({
			type: 'marketplace_import_playbook',
			sessionId: 'a1',
			playbookId: 'security-audit',
			targetFolderName: 'security-audit',
		});
	});

	it('import honors --folder and reports an app-side failure', async () => {
		const sent = mockBridge_1({
			marketplace_import_playbook: { success: false, error: 'folder exists' },
		});
		await expect(marketplaceImport('docs-pass', { agent: 'a1', folder: 'mine' })).rejects.toThrow(
			'__exit__'
		);
		expect(sent[0]).toMatchObject({ targetFolderName: 'mine' });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
