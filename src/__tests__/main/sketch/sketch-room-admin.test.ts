/**
 * The Room panel service (src/main/sketch/sketch-room-admin.ts, spec sections
 * 6, 8.8 and 9): `room.stats` read through the owning window, Kick, Unlock
 * and Unsuspend sent through its room client, the A1 confirmation for an
 * agent's Unlock and Unsuspend (Kick runs), and the audit log read from disk.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every dependency the tests use is injected; the app defaults stay unloaded.
vi.mock('../../../main/sketch/sketch-service', () => ({ findSketchOwnerAgent: vi.fn() }));
vi.mock('../../../main/sketch/sketch-store', () => ({ getSketchStore: vi.fn() }));
vi.mock('../../../main/sketch/sketch-guardrail', () => ({ sketchAuditPath: vi.fn() }));
vi.mock('../../../main/sketch/sketch-renderer-bridge', () => ({ requestSketchRenderer: vi.fn() }));
vi.mock('../../../main/sketch/sketch-desktop-confirm', () => ({
	confirmSketchActionOnDesktop: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({ getSettingsStore: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createSketchRoomAdminService } from '../../../main/sketch/sketch-room-admin';
import type { SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchStore } from '../../../main/sketch/sketch-store';
import type { SketchRendererRequest, SketchRendererResult } from '../../../shared/sketch/commands';
import type { SketchRoomStatsReading } from '../../../shared/sketch/room-admin';
import type { SketchRoomStats } from '../../../shared/sketch/room-stats';
import type { SketchRecord } from '../../../shared/sketch/types';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const agent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false, cwd: '/p' };

const stats: SketchRoomStats = {
	guestEdited: true,
	actors: [
		{
			actorId: 'guest-1',
			kind: 'guest',
			name: 'Sam',
			capId: 'Cap000000001',
			capLabel: '#3',
			role: 'rw',
			online: true,
			ops: 4,
			toBot: 3,
			denyStreak: 3,
			denialsTotal: 3,
			guardrailTotal: 3,
			guardrailByReason: { injection: 3, other: 0 },
			unavailableTotal: 0,
			lockedOut: true,
			lastSeen: 1,
		},
	],
	caps: [
		{
			capId: 'Cap000000001',
			label: 'Review',
			role: 'rw',
			expiresAt: null,
			revoked: false,
			botSuspended: true,
			guardrailTotal: 5,
			online: 1,
		},
	],
	flaggedActors: ['guest-1'],
	screening: 'local',
	screeningSince: 1,
};

const reading: SketchRoomStatsReading = { sketchId: SKETCH_ID, connection: 'live', stats };

function makeRecord(shared: boolean): SketchRecord {
	return {
		sketchId: SKETCH_ID,
		ownerAgentId: agent.id,
		name: 'Board',
		filePath: `/sketches/agent-1/${SKETCH_ID}.excalidraw`,
		createdAt: 1,
		share: shared ? { roomId: 'room-1', keyEpoch: 0, links: [], botPolicy: 'conductor' } : null,
		guestEdited: false,
	};
}

function auditLine(fields: Record<string, unknown>): string {
	return JSON.stringify({
		ts: 10,
		sketchId: SKETCH_ID,
		subject: { elementId: 'el-1', version: 2 },
		actor: { id: 'guest-1', kind: 'guest', capId: 'Cap000000001' },
		status: 'flagged',
		score: 0.97,
		source: 'Prompt Guard 2 22M',
		locality: 'local',
		reported: true,
		...fields,
	});
}

function setup(options: { shared?: boolean; enabled?: boolean } = {}) {
	const record = makeRecord(options.shared ?? true);
	const sketches = {
		getSketch: vi.fn(async (id: string) => (id === SKETCH_ID ? record : null)),
	} as unknown as SketchStore;
	const deps = {
		store: () => sketches,
		isEnabled: vi.fn(() => options.enabled ?? true),
		findAgent: vi.fn((id: string) => (id === agent.id ? agent : null)),
		renderer: vi.fn(
			async (
				_agentId: string | null,
				_request: SketchRendererRequest
			): Promise<SketchRendererResult> => ({
				success: true,
				roomStats: reading,
			})
		),
		confirm: vi.fn(async (_prompt: unknown) => true),
		auditPath: vi.fn(async () => '/sketches/agent-1/audit.jsonl'),
		readAudit: vi.fn(async (): Promise<string | null> => null),
	};
	return { deps, service: createSketchRoomAdminService(deps) };
}

describe('sketch room admin service', () => {
	let ctx: ReturnType<typeof setup>;

	beforeEach(() => {
		ctx = setup();
	});

	it('reads the room stats through the window that owns the sketch', async () => {
		await expect(ctx.service.stats(SKETCH_ID)).resolves.toEqual(reading);
		expect(ctx.deps.renderer).toHaveBeenCalledWith(agent.id, {
			action: 'roomAdmin',
			sketchId: SKETCH_ID,
			op: 'stats',
		});
	});

	it('refuses a sketch that is not shared, and everything while Sketch Book is off', async () => {
		await expect(setup({ shared: false }).service.stats(SKETCH_ID)).rejects.toThrow(
			'"Board" is not shared'
		);
		await expect(setup({ enabled: false }).service.stats(SKETCH_ID)).rejects.toThrow(/Sketch Book/);
	});

	it('reports a window failure as the error', async () => {
		ctx.deps.renderer.mockResolvedValueOnce({ success: false, error: 'Sketch Book: no room.' });
		await expect(ctx.service.stats(SKETCH_ID)).rejects.toThrow('Sketch Book: no room.');
	});

	it("runs an agent's kick without a confirmation", async () => {
		await ctx.service.act(
			SKETCH_ID,
			'kick',
			{ actorId: 'guest-1', minutes: 30 },
			{ requestedBy: 'Helper' }
		);
		expect(ctx.deps.confirm).not.toHaveBeenCalled();
		expect(ctx.deps.renderer).toHaveBeenLastCalledWith(agent.id, {
			action: 'roomAdmin',
			sketchId: SKETCH_ID,
			op: 'kick',
			actorId: 'guest-1',
			minutes: 30,
		});
	});

	it('refuses a kick length out of range before anything is sent', async () => {
		await expect(
			ctx.service.act(SKETCH_ID, 'kick', { actorId: 'guest-1', minutes: 0 })
		).rejects.toThrow(/whole number of minutes/);
		await expect(
			ctx.service.act(SKETCH_ID, 'kick', { actorId: 'guest-1', minutes: 99_999 })
		).rejects.toThrow(/whole number of minutes/);
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});

	it('needs an actor id for kick and unlock, and a link id for unsuspend', async () => {
		await expect(ctx.service.act(SKETCH_ID, 'unlock', {})).rejects.toThrow('actorId');
		await expect(ctx.service.act(SKETCH_ID, 'unsuspend', { actorId: 'guest-1' })).rejects.toThrow(
			'capId'
		);
		await expect(ctx.service.act(SKETCH_ID, 'stats' as never, {})).rejects.toThrow(
			'kick, unlock or unsuspend'
		);
	});

	it("runs the conductor's unlock and unsuspend with no confirmation", async () => {
		await ctx.service.act(SKETCH_ID, 'unlock', { actorId: 'guest-1' });
		await ctx.service.act(SKETCH_ID, 'unsuspend', { capId: 'Cap000000001' });
		expect(ctx.deps.confirm).not.toHaveBeenCalled();
		expect(ctx.deps.renderer).toHaveBeenLastCalledWith(agent.id, {
			action: 'roomAdmin',
			sketchId: SKETCH_ID,
			op: 'unsuspend',
			capId: 'Cap000000001',
		});
	});

	it("asks the conductor before an agent's unlock, naming the guest (A1)", async () => {
		await ctx.service.act(SKETCH_ID, 'unlock', { actorId: 'guest-1' }, { requestedBy: 'Helper' });
		expect(ctx.deps.confirm).toHaveBeenCalledTimes(1);
		const prompt = ctx.deps.confirm.mock.calls[0][0] as unknown as Record<string, string>;
		expect(prompt.requestedBy).toBe('Helper');
		expect(prompt.title).toBe('Unlock a guest?');
		expect(prompt.message).toContain('"Sam" · guest, read-write link #3, not verified');
		expect(ctx.deps.renderer).toHaveBeenLastCalledWith(
			agent.id,
			expect.objectContaining({ op: 'unlock', actorId: 'guest-1' })
		);
	});

	it("names the link in the confirmation for an agent's unsuspend", async () => {
		await ctx.service.act(
			SKETCH_ID,
			'unsuspend',
			{ capId: 'Cap000000001' },
			{ requestedBy: 'Helper' }
		);
		const prompt = ctx.deps.confirm.mock.calls[0][0] as unknown as Record<string, string>;
		expect(prompt.title).toBe('Unsuspend a sketch link?');
		expect(prompt.message).toContain('the link "Review"');
	});

	it('changes nothing when the conductor chooses Deny', async () => {
		ctx.deps.confirm.mockResolvedValueOnce(false);
		await expect(
			ctx.service.act(SKETCH_ID, 'unlock', { actorId: 'guest-1' }, { requestedBy: 'Helper' })
		).rejects.toThrow('chose Deny');
		// Only the stats read for the prompt went to the window.
		expect(ctx.deps.renderer).toHaveBeenCalledTimes(1);
		expect(ctx.deps.renderer.mock.calls[0][1]).toEqual(expect.objectContaining({ op: 'stats' }));
	});

	it('reads an audit log that does not exist yet as empty', async () => {
		await expect(ctx.service.audit(SKETCH_ID)).resolves.toEqual({
			sketchId: SKETCH_ID,
			entries: [],
			flagged: [],
		});
		expect(ctx.deps.readAudit).toHaveBeenCalledWith('/sketches/agent-1/audit.jsonl');
	});

	it('reads the audit log, skips lines that do not parse, and lists the flagged elements', async () => {
		ctx.deps.readAudit.mockResolvedValueOnce(
			[
				auditLine({}),
				'not json',
				auditLine({ subject: { replyTo: 'r1' }, status: 'clean', reported: false }),
				auditLine({ subject: { elementId: 'el-2', version: 1 }, status: 'clean', ts: 11 }),
				'',
			].join('\n')
		);
		const audit = await ctx.service.audit(SKETCH_ID);
		expect(audit.entries).toHaveLength(3);
		expect(audit.flagged).toEqual([
			{
				elementId: 'el-1',
				version: 2,
				actor: { id: 'guest-1', kind: 'guest', capId: 'Cap000000001' },
				score: 0.97,
				source: 'Prompt Guard 2 22M',
				locality: 'local',
				ts: 10,
			},
		]);
	});

	it('reads the audit log of a sketch that is not shared', async () => {
		const local = setup({ shared: false });
		await expect(local.service.audit(SKETCH_ID)).resolves.toEqual(
			expect.objectContaining({ entries: [] })
		);
	});
});
