/**
 * The B2 policy service (src/main/sketch/sketch-bot-policy.ts, spec sections
 * 5 and 8.3 rule 2): `writers` only while B2 is available, the trust warning
 * as the desktop confirmation for an agent caller (A1), the room's word
 * mirrored into the record, a room on `writers` put back on `conductor` when
 * B2 goes, and the one-click Prompt Guard 2 download.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	settingsListeners: new Map<string, () => void>(),
	systemOneListener: null as (() => void) | null,
}));

// Every dependency the tests use is injected; the app defaults stay unloaded.
vi.mock('../../../main/sketch/sketch-service', () => ({ findSketchOwnerAgent: vi.fn() }));
vi.mock('../../../main/sketch/sketch-store', () => ({ getSketchStore: vi.fn() }));
vi.mock('../../../main/sketch/sketch-guardrail', () => ({ isB2Available: vi.fn() }));
vi.mock('../../../main/sketch/sketch-renderer-bridge', () => ({ requestSketchRenderer: vi.fn() }));
vi.mock('../../../main/sketch/sketch-desktop-confirm', () => ({
	confirmSketchActionOnDesktop: vi.fn(),
}));
vi.mock('../../../main/local-models/service', () => ({ installLocalModel: vi.fn() }));
vi.mock('../../../main/local-models/injection-screen', () => ({
	resolveLocalInjectionClassifier: vi.fn(),
}));
vi.mock('../../../main/local-models/system-one/service', () => ({
	onSystemOneChanged: (listener: () => void) => {
		h.systemOneListener = listener;
		return () => {
			h.systemOneListener = null;
		};
	},
}));
vi.mock('../../../main/stores/getters', () => ({ getSettingsStore: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	createSketchBotPolicyService,
	type SketchBotPolicyDeps,
} from '../../../main/sketch/sketch-bot-policy';
import type { LocalModelInstallResult } from '../../../main/local-models/service';
import type { LocalInjectionClassifier } from '../../../main/local-models/injection-screen';
import type { SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchRendererResult } from '../../../shared/sketch/commands';
import type { SketchStore } from '../../../main/sketch/sketch-store';
import type { LocalModelAssignments } from '../../../shared/local-models/tasks';
import type { SketchB2Availability } from '../../../shared/sketch/bot-policy';
import type { SketchRecord, SketchShare } from '../../../shared/sketch/types';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';
const agent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false, cwd: '/p' };
const BLOCKED: SketchB2Availability = { ok: false, reason: 'The screen is off.' };

function share(botPolicy: SketchShare['botPolicy']): SketchShare {
	return { roomId: 'room-1', keyEpoch: 0, links: [], botPolicy };
}

function makeRecord(id: string, shared: SketchShare | null): SketchRecord {
	return {
		sketchId: id,
		ownerAgentId: agent.id,
		name: id === SKETCH_ID ? 'Board' : 'Other',
		filePath: `/sketches/agent-1/${id}.excalidraw`,
		createdAt: 1,
		share: shared,
		guestEdited: false,
	};
}

function setup(initial: SketchRecord[] = [makeRecord(SKETCH_ID, share('conductor'))]) {
	const records = new Map(initial.map((record) => [record.sketchId, record]));
	const sketches = {
		getSketch: vi.fn(async (id: string) => records.get(id) ?? null),
		listSketches: vi.fn(async () => [...records.values()]),
		updateSketchShare: vi.fn(
			async (id: string, change: (prev: SketchShare | null) => SketchShare | null) => {
				const record = records.get(id)!;
				const next = { ...record, share: change(record.share) };
				records.set(id, next);
				return next;
			}
		),
	} as unknown as SketchStore;
	let assignments: LocalModelAssignments = {};
	const deps = {
		store: () => sketches,
		isEnabled: vi.fn(() => true),
		availability: vi.fn(async (): Promise<SketchB2Availability> => ({ ok: true })),
		findAgent: vi.fn((id: string) => (id === agent.id ? agent : null)),
		renderer: vi.fn(async (): Promise<SketchRendererResult> => ({ success: true })),
		confirm: vi.fn(async () => true),
		installModel: vi.fn(
			async (_modelId: string): Promise<LocalModelInstallResult> => ({
				modelId: 'prompt-guard-2-22m',
				status: 'complete',
				runtime: { runtimeId: 'onnx' as never, status: 'installed' },
			})
		),
		findLocalClassifier: vi.fn(async (): Promise<LocalInjectionClassifier | null> => null),
		readAssignments: vi.fn(() => assignments),
		writeAssignments: vi.fn((next: LocalModelAssignments) => {
			assignments = next;
		}),
		publish: vi.fn(),
	};
	return {
		deps,
		records,
		sketches,
		service: createSketchBotPolicyService(deps satisfies SketchBotPolicyDeps),
		assignments: () => assignments,
		setAssignments: (next: LocalModelAssignments) => {
			assignments = next;
		},
	};
}

describe('status', () => {
	it("reads the record's policy and B2 availability for the owner", async () => {
		const ctx = setup();
		ctx.deps.availability.mockResolvedValueOnce(BLOCKED);
		await expect(ctx.service.status(SKETCH_ID)).resolves.toEqual({
			sketchId: SKETCH_ID,
			policy: 'conductor',
			availability: BLOCKED,
		});
		expect(ctx.deps.availability).toHaveBeenCalledWith({ agentId: 'agent-1' });
	});

	it('says null for a sketch that is not shared', async () => {
		const ctx = setup([makeRecord(SKETCH_ID, null)]);
		await expect(ctx.service.status(SKETCH_ID)).resolves.toMatchObject({ policy: null });
	});

	it('refuses while Sketch Book is off, and an unknown sketch', async () => {
		const ctx = setup();
		await expect(ctx.service.status(OTHER_ID)).rejects.toThrow(/no sketch has the id/);
		ctx.deps.isEnabled.mockReturnValue(false);
		await expect(ctx.service.status(SKETCH_ID)).rejects.toThrow(/Sketch Book/);
	});
});

describe('setPolicy', () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it('sends writers through the owning window and mirrors it into the record', async () => {
		const status = await ctx.service.setPolicy(SKETCH_ID, 'writers');
		expect(ctx.deps.renderer).toHaveBeenCalledWith('agent-1', {
			action: 'botPolicy',
			sketchId: SKETCH_ID,
			botPolicy: 'writers',
		});
		expect(status).toEqual({ sketchId: SKETCH_ID, policy: 'writers', availability: { ok: true } });
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('writers');
		expect(ctx.deps.publish).toHaveBeenCalledWith({ sketchId: SKETCH_ID });
		// A person in the tab confirmed in place; no desktop dialog.
		expect(ctx.deps.confirm).not.toHaveBeenCalled();
	});

	it('refuses writers while B2 is unavailable, with the reason, and sends nothing', async () => {
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		await expect(ctx.service.setPolicy(SKETCH_ID, 'writers')).rejects.toThrow(
			/cannot ask the agent on "Board". The screen is off./
		);
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('conductor');
	});

	it("asks the conductor with the trust warning for an agent's writers (A1)", async () => {
		await ctx.service.setPolicy(SKETCH_ID, 'writers', { requestedBy: 'Helper' });
		expect(ctx.deps.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Let collaborators ask the agent?',
				message: expect.stringContaining('"Board"'),
				requestedBy: 'Helper',
			})
		);
		expect(ctx.deps.renderer).toHaveBeenCalled();
	});

	it("changes nothing when the conductor denies an agent's writers", async () => {
		ctx.deps.confirm.mockResolvedValue(false);
		await expect(
			ctx.service.setPolicy(SKETCH_ID, 'writers', { requestedBy: 'Helper' })
		).rejects.toThrow(/chose Deny/);
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});

	it('checks availability again after the conductor answers', async () => {
		ctx.deps.availability.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(BLOCKED);
		await expect(
			ctx.service.setPolicy(SKETCH_ID, 'writers', { requestedBy: 'Helper' })
		).rejects.toThrow(/The screen is off./);
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});

	it('runs conductor from an agent with no confirmation, even while B2 is unavailable', async () => {
		ctx = setup([makeRecord(SKETCH_ID, share('writers'))]);
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		await ctx.service.setPolicy(SKETCH_ID, 'conductor', { requestedBy: 'Helper' });
		expect(ctx.deps.confirm).not.toHaveBeenCalled();
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('conductor');
	});

	it('refuses a sketch that is not shared, a bad policy, and an owner that is gone', async () => {
		ctx = setup([makeRecord(SKETCH_ID, null)]);
		await expect(ctx.service.setPolicy(SKETCH_ID, 'conductor')).rejects.toThrow(/not shared/);

		ctx = setup();
		await expect(ctx.service.setPolicy(SKETCH_ID, 'everyone' as never)).rejects.toThrow(
			/"conductor" or "writers"/
		);

		ctx.deps.findAgent.mockReturnValue(null);
		await expect(ctx.service.setPolicy(SKETCH_ID, 'conductor')).rejects.toThrow(/is gone/);
	});

	it("passes the window's refusal on and leaves the record alone", async () => {
		ctx.deps.renderer.mockResolvedValue({
			success: false,
			error: 'Sketch Book: the room is not connected yet. Try again once it is.',
		});
		await expect(ctx.service.setPolicy(SKETCH_ID, 'writers')).rejects.toThrow(/not connected yet/);
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('conductor');
	});
});

describe('noteRoomPolicy', () => {
	it("mirrors the room's word into the record", async () => {
		const ctx = setup();
		await expect(ctx.service.noteRoomPolicy(SKETCH_ID, 'writers')).resolves.toMatchObject({
			policy: 'writers',
		});
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('writers');
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});

	it('puts a room on writers back on conductor when B2 is gone, with the notice', async () => {
		const ctx = setup([makeRecord(SKETCH_ID, share('writers'))]);
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		const status = await ctx.service.noteRoomPolicy(SKETCH_ID, 'writers');
		expect(ctx.deps.renderer).toHaveBeenCalledWith('agent-1', {
			action: 'botPolicy',
			sketchId: SKETCH_ID,
			botPolicy: 'conductor',
			notice: 'Collaborators can no longer ask the agent: The screen is off.',
		});
		expect(status.policy).toBe('conductor');
	});

	it('leaves the record on writers when the demotion cannot reach a window', async () => {
		const ctx = setup([makeRecord(SKETCH_ID, share('writers'))]);
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		ctx.deps.renderer.mockResolvedValue({ success: false, error: 'No window.' });
		await expect(ctx.service.noteRoomPolicy(SKETCH_ID, 'writers')).resolves.toMatchObject({
			policy: 'writers',
		});
	});

	it('never demotes a room on conductor', async () => {
		const ctx = setup();
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		await ctx.service.noteRoomPolicy(SKETCH_ID, 'conductor');
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});
});

describe('enforce', () => {
	it('demotes every shared sketch on writers whose B2 is gone, and nothing else', async () => {
		const ctx = setup([
			makeRecord(SKETCH_ID, share('writers')),
			makeRecord(OTHER_ID, share('conductor')),
		]);
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		await ctx.service.enforce();
		expect(ctx.deps.renderer).toHaveBeenCalledTimes(1);
		expect(ctx.deps.renderer).toHaveBeenCalledWith(
			'agent-1',
			expect.objectContaining({ sketchId: SKETCH_ID, botPolicy: 'conductor' })
		);
		expect(ctx.records.get(SKETCH_ID)!.share!.botPolicy).toBe('conductor');
		// Every window reads availability again, demoted or not.
		expect(ctx.deps.publish).toHaveBeenCalledWith({});
	});

	it('leaves a room on writers alone while B2 holds', async () => {
		const ctx = setup([makeRecord(SKETCH_ID, share('writers'))]);
		await ctx.service.enforce();
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});

	it('reads availability once per owner', async () => {
		const ctx = setup([
			makeRecord(SKETCH_ID, share('writers')),
			makeRecord(OTHER_ID, share('writers')),
		]);
		await ctx.service.enforce();
		expect(ctx.deps.availability).toHaveBeenCalledTimes(1);
	});

	it('does nothing while Sketch Book is off', async () => {
		const ctx = setup([makeRecord(SKETCH_ID, share('writers'))]);
		ctx.deps.isEnabled.mockReturnValue(false);
		ctx.deps.availability.mockResolvedValue(BLOCKED);
		await ctx.service.enforce();
		expect(ctx.deps.renderer).not.toHaveBeenCalled();
	});
});

describe('installScreen', () => {
	it('installs Prompt Guard 2 and assigns it to the screen', async () => {
		const ctx = setup();
		await expect(ctx.service.installScreen()).resolves.toEqual({ installed: true, assigned: true });
		expect(ctx.deps.installModel).toHaveBeenCalledWith('prompt-guard-2-22m');
		expect(ctx.assignments()['injection-screen']).toEqual({
			type: 'local',
			modelId: 'prompt-guard-2-22m',
		});
		expect(ctx.deps.publish).toHaveBeenCalledWith({});
	});

	it('never replaces a source assigned while the download ran', async () => {
		const ctx = setup();
		ctx.setAssignments({ 'injection-screen': { type: 'system-one' } });
		await expect(ctx.service.installScreen()).resolves.toEqual({
			installed: true,
			assigned: false,
		});
		expect(ctx.deps.writeAssignments).not.toHaveBeenCalled();
	});

	it('reports a failed download or runtime without assigning', async () => {
		const ctx = setup();
		ctx.deps.installModel.mockResolvedValueOnce({
			modelId: 'prompt-guard-2-22m',
			status: 'error',
			error: 'Network down.',
			runtime: { runtimeId: 'onnx' as never, status: 'installed' },
		});
		await expect(ctx.service.installScreen()).resolves.toEqual({
			installed: false,
			assigned: false,
			error: 'Network down.',
		});
		ctx.deps.installModel.mockResolvedValueOnce({
			modelId: 'prompt-guard-2-22m',
			status: 'complete',
			runtime: { runtimeId: 'onnx' as never, status: 'failed', error: 'Bad hash.' },
		});
		await expect(ctx.service.installScreen()).resolves.toMatchObject({
			installed: false,
			error: 'Bad hash.',
		});
		expect(ctx.deps.writeAssignments).not.toHaveBeenCalled();
	});
});

describe('Keep local (switchScreenToLocal, localScreenOption)', () => {
	const installed: LocalInjectionClassifier = {
		modelId: 'prompt-guard-2-22m',
		source: { kind: 'local-classifier', locality: 'local', label: 'Prompt Guard 2 22M' },
	};

	it('names the installed local classifier, or none', async () => {
		const ctx = setup();
		await expect(ctx.service.localScreenOption()).resolves.toEqual({ installed: null });
		ctx.deps.findLocalClassifier.mockResolvedValueOnce(installed);
		await expect(ctx.service.localScreenOption()).resolves.toEqual({
			installed: { modelId: 'prompt-guard-2-22m', label: 'Prompt Guard 2 22M' },
		});
	});

	it('replaces the System One source with the installed classifier, downloading nothing', async () => {
		const ctx = setup();
		ctx.setAssignments({ 'injection-screen': { type: 'system-one' } });
		ctx.deps.findLocalClassifier.mockResolvedValueOnce(installed);
		await expect(ctx.service.switchScreenToLocal()).resolves.toEqual({
			installed: true,
			assigned: true,
		});
		expect(ctx.deps.installModel).not.toHaveBeenCalled();
		expect(ctx.assignments()['injection-screen']).toEqual({
			type: 'local',
			modelId: 'prompt-guard-2-22m',
		});
		expect(ctx.deps.publish).toHaveBeenCalledWith({});
	});

	it('downloads Prompt Guard 2 first when no classifier is installed', async () => {
		const ctx = setup();
		ctx.setAssignments({ 'injection-screen': { type: 'system-one' } });
		await expect(ctx.service.switchScreenToLocal()).resolves.toEqual({
			installed: true,
			assigned: true,
		});
		expect(ctx.deps.installModel).toHaveBeenCalledWith('prompt-guard-2-22m');
		expect(ctx.assignments()['injection-screen']).toEqual({
			type: 'local',
			modelId: 'prompt-guard-2-22m',
		});
	});

	it('reports a failed download and leaves the assignment alone', async () => {
		const ctx = setup();
		ctx.setAssignments({ 'injection-screen': { type: 'system-one' } });
		ctx.deps.installModel.mockResolvedValueOnce({
			modelId: 'prompt-guard-2-22m',
			status: 'error',
			error: 'Network down.',
			runtime: { runtimeId: 'onnx' as never, status: 'installed' },
		});
		await expect(ctx.service.switchScreenToLocal()).resolves.toEqual({
			installed: false,
			assigned: false,
			error: 'Network down.',
		});
		expect(ctx.deps.writeAssignments).not.toHaveBeenCalled();
	});

	it('never replaces a local pick made while the dialog was open', async () => {
		const ctx = setup();
		ctx.setAssignments({ 'injection-screen': { type: 'local', modelId: 'prompt-guard-2-22m' } });
		ctx.deps.findLocalClassifier.mockResolvedValueOnce(installed);
		await expect(ctx.service.switchScreenToLocal()).resolves.toEqual({
			installed: true,
			assigned: false,
		});
		expect(ctx.deps.writeAssignments).not.toHaveBeenCalled();
	});

	it('refuses while Sketch Book is off', async () => {
		const ctx = setup();
		ctx.deps.isEnabled.mockReturnValue(false);
		await expect(ctx.service.switchScreenToLocal()).rejects.toThrow();
		await expect(ctx.service.localScreenOption()).rejects.toThrow();
	});
});
