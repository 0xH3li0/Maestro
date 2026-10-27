/**
 * The main-process half of Sketch Book bot turns (src/main/sketch/sketch-bot-turns.ts,
 * spec section 5): the posture check before the digest (risk K1), the gated
 * digest the turn starts with, the outbound screen on the reply (spec section
 * 8.5), and the sketch's own provider session (Q3).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSketchBotTurnService } from '../../../main/sketch/sketch-bot-turns';
import type { SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchRecord } from '../../../shared/sketch/types';

// Every dependency is injected below; the app defaults stay unloaded.
vi.mock('../../../main/sketch/sketch-service', () => ({
	findSketchOwnerAgent: vi.fn(),
	getSketchService: vi.fn(),
}));
vi.mock('../../../main/sketch/sketch-store', () => ({ getSketchStore: vi.fn() }));
vi.mock('../../../main/sketch/sketch-tools', () => ({ getSketchToolRuntime: vi.fn() }));
vi.mock('../../../main/sketch/sketch-guardrail', () => ({
	sketchAgentRestrictedPostureBlocker: vi.fn(),
}));
vi.mock('../../../main/sketch/sketch-outbound', () => ({ screenOutbound: vi.fn() }));

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const agent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false, cwd: '/p' };
const record: SketchRecord = {
	sketchId: SKETCH_ID,
	ownerAgentId: agent.id,
	name: 'Board',
	filePath: '/sketches/agent-1/board.excalidraw',
	createdAt: 1,
	share: null,
	guestEdited: false,
};

function setup(overrides: Partial<Parameters<typeof createSketchBotTurnService>[0]> = {}) {
	const deps = {
		getSketch: vi.fn(async (id: string) => (id === SKETCH_ID ? record : null)),
		storeBotSessionId: vi.fn(async (_id: string, botSessionId: string | null) => ({
			...record,
			...(botSessionId ? { botSessionId } : {}),
		})),
		findAgent: vi.fn((id: string) => (id === agent.id ? agent : null)),
		postureBlocker: vi.fn((): string | null => null),
		changeDigest: vi.fn(async () => ({
			digest: 'No changes since your last read.',
			sceneVersion: 7,
			changes: {} as never,
		})),
		outbound: vi.fn(async () => ({ ok: true as const, texts: ['Done.'], redactedCount: 0 })),
		...overrides,
	};
	return { deps, service: createSketchBotTurnService(deps) };
}

describe('prepareBotTurn', () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("returns the owner, the sketch and the digest built for the turn's posture", async () => {
		await expect(ctx.service.prepareBotTurn(SKETCH_ID, 'restricted')).resolves.toEqual({
			ok: true,
			agentId: 'agent-1',
			agentName: 'Builder',
			sketchName: 'Board',
			digest: 'No changes since your last read.',
			sceneVersion: 7,
			botSessionId: null,
		});
		expect(ctx.deps.changeDigest).toHaveBeenCalledWith({
			agentId: 'agent-1',
			sketchId: SKETCH_ID,
			posture: 'restricted',
		});
	});

	it('hands back the stored bot session', async () => {
		const { service } = setup({
			getSketch: vi.fn(async () => ({ ...record, botSessionId: 'session-9' })),
		});
		await expect(service.prepareBotTurn(SKETCH_ID, 'full')).resolves.toMatchObject({
			botSessionId: 'session-9',
		});
	});

	it('refuses a restricted turn the provider cannot hold, before reading the digest (K1)', async () => {
		const blocked = setup({ postureBlocker: vi.fn(() => 'Plan mode refuses the sketch tools.') });
		await expect(blocked.service.prepareBotTurn(SKETCH_ID, 'restricted')).resolves.toEqual({
			ok: false,
			reason: 'Plan mode refuses the sketch tools.',
			blockedByPosture: true,
		});
		expect(blocked.deps.changeDigest).not.toHaveBeenCalled();
		// A full turn does not ask.
		await expect(blocked.service.prepareBotTurn(SKETCH_ID, 'full')).resolves.toMatchObject({
			ok: true,
		});
	});

	it('refuses when the owner is gone or runs over SSH', async () => {
		const gone = setup({ findAgent: vi.fn(() => null) });
		await expect(gone.service.prepareBotTurn(SKETCH_ID, 'full')).resolves.toEqual({
			ok: false,
			reason: 'The owner agent was removed.',
		});
		const remote = setup({ findAgent: vi.fn(() => ({ ...agent, sshRemote: true })) });
		await expect(remote.service.prepareBotTurn(SKETCH_ID, 'full')).resolves.toMatchObject({
			ok: false,
		});
		expect(remote.deps.changeDigest).not.toHaveBeenCalled();
	});

	it('rejects a bad posture and an unknown sketch', async () => {
		await expect(ctx.service.prepareBotTurn(SKETCH_ID, 'yolo' as never)).rejects.toThrow(/posture/);
		await expect(ctx.service.prepareBotTurn('nope', 'full')).rejects.toThrow(/no sketch/);
	});
});

describe('screenBotReply', () => {
	it('screens the reply as a bot reply on behalf of the owner', async () => {
		const { deps, service } = setup();
		await expect(service.screenBotReply(SKETCH_ID, 'Done.')).resolves.toEqual({
			ok: true,
			text: 'Done.',
		});
		expect(deps.outbound).toHaveBeenCalledWith({
			sketchId: SKETCH_ID,
			agentId: 'agent-1',
			purpose: 'bot-reply',
			texts: ['Done.'],
		});
	});

	it('passes a hold and a note through, and a refusal without its finding kinds', async () => {
		const held = setup({
			outbound: vi.fn(async () => ({
				ok: true as const,
				texts: ['[redacted]'],
				redactedCount: 1,
				held: true as const,
				heldReason: 'Flagged by Prompt Guard 2 (0.93).',
				note: 'The model pass ran locally.',
			})),
		});
		await expect(held.service.screenBotReply(SKETCH_ID, 'ghp_x')).resolves.toEqual({
			ok: true,
			text: '[redacted]',
			held: true,
			heldReason: 'Flagged by Prompt Guard 2 (0.93).',
			note: 'The model pass ran locally.',
		});

		const refused = setup({
			outbound: vi.fn(async () => ({
				ok: false as const,
				reason: 'credential-shaped text in the bot reply: GitHub token.',
				kinds: ['github-token' as never],
			})),
		});
		await expect(refused.service.screenBotReply(SKETCH_ID, 'x')).resolves.toEqual({
			ok: false,
			reason: 'credential-shaped text in the bot reply: GitHub token.',
		});
	});

	it('rejects a reply that is not text', async () => {
		const { service } = setup();
		await expect(service.screenBotReply(SKETCH_ID, 42 as never)).rejects.toThrow(/text/);
	});
});

describe('setBotSessionId', () => {
	it('stores the session for the sketch, and null forgets it', async () => {
		const { deps, service } = setup();
		await expect(service.setBotSessionId(SKETCH_ID, 'session-1')).resolves.toMatchObject({
			botSessionId: 'session-1',
		});
		expect(deps.storeBotSessionId).toHaveBeenCalledWith(SKETCH_ID, 'session-1');
		await service.setBotSessionId(SKETCH_ID, null);
		expect(deps.storeBotSessionId).toHaveBeenLastCalledWith(SKETCH_ID, null);
	});

	it('rejects an empty session id and an unknown sketch', async () => {
		const { service } = setup();
		await expect(service.setBotSessionId(SKETCH_ID, '')).rejects.toThrow(/botSessionId/);
		await expect(service.setBotSessionId('nope', 'x')).rejects.toThrow(/no sketch/);
	});
});
