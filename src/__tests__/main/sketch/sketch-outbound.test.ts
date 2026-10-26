/**
 * @file sketch-outbound.test.ts
 *
 * The Sketch Book outbound screen (src/main/sketch/sketch-outbound.ts, spec
 * section 8.5) over the real `redactSecrets()` and `screenForSecrets()`, with
 * the task router mocked. Properties worth protecting:
 *
 *   - **Pattern refusal**: credential-shaped text that redaction does not
 *     replace, or the value of a configured secret env var, refuses the whole
 *     write and names the finding kinds, never the value.
 *   - **Model hold**: on a chat message a model flag holds it (`held: true`)
 *     and never refuses; a model that cannot run is a note, never a block.
 *   - **Order**: the model is asked only after the patterns are clean, so a
 *     configured secret never reaches a model engine.
 *   - **Element writes** never run the model pass.
 *   - **Cloud consent**: a cloud System One engine runs only when the room's
 *     cloud screening policy allows it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/local-models/task-router', () => ({
	runClassifierTask: vi.fn(),
	runSystemOneTask: vi.fn(),
}));

const stores = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => stores.settings[key] }),
	getAgentConfigsStore: () => ({ get: () => ({}) }),
	getSessionsStore: () => ({ get: () => [] }),
}));
// The guardrail module is heavy; the outbound screen reads only its policy.
vi.mock('../../../main/sketch/sketch-guardrail', () => ({
	getSketchCloudScreeningPolicy: () => ({
		hasConsent: () => false,
		isCloudScreeningAllowed: () => false,
		cloudScreeningSince: () => null,
	}),
}));

import { runClassifierTask, runSystemOneTask } from '../../../main/local-models/task-router';
import {
	screenOutbound,
	type OutboundScreenRequest,
	type SketchOutboundDeps,
} from '../../../main/sketch/sketch-outbound';
import type { SketchCloudScreeningPolicy } from '../../../main/sketch/sketch-guardrail';
import { PROMPT_GUARD_2_22M_ID } from '../../../shared/local-models/model-catalog';

// Assembled at runtime so no token literal sits in the repository.
const SLACK_TOKEN = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhAbCdEfGhAbCdEfGh'].join('-');
const CONFIGURED = 'correct-horse-battery-staple-77';
const ENV: SketchOutboundDeps['env'] = [['DEPLOY_TOKEN', CONFIGURED]];
const SOURCE = { type: 'local', modelId: PROMPT_GUARD_2_22M_ID } as const;
const JEV = 'Jev (TypeSafe cloud)';

function request(
	purpose: OutboundScreenRequest['purpose'],
	texts: string[]
): OutboundScreenRequest {
	return { sketchId: 'sk-1', agentId: 'alpha', purpose, texts };
}

function classifierVerdict(flagged: boolean) {
	return {
		status: 'ok' as const,
		label: flagged ? 'MALICIOUS' : 'BENIGN',
		score: flagged ? 0.91 : 0.02,
		flagged,
		chunks: 1,
		source: SOURCE,
		durationMs: 12,
	};
}

/** A cloud policy that allows exactly what `allowed` says. */
function policy(allowed: boolean): () => SketchCloudScreeningPolicy {
	return () => ({
		hasConsent: () => allowed,
		isCloudScreeningAllowed: () => allowed,
		cloudScreeningSince: () => (allowed ? 1 : null),
	});
}

/** System One assigned to Jev: the router offers Jev to the caller's check first. */
function jevAssigned() {
	vi.mocked(runSystemOneTask).mockImplementation(async (_taskId, _input, options) => {
		const refused = options?.allowEngine?.(
			{
				id: 'jev-cloud',
				engine: { baseUrl: 'https://api.typesafe.ai' },
				timeoutMs: 1500,
				key: {},
				refusal: null,
			} as never,
			JEV
		);
		if (refused) {
			return {
				status: 'unavailable',
				engine: 'jev-cloud',
				engineLabel: JEV,
				code: 'unavailable',
				reason: refused,
			};
		}
		return { status: 'ok', engineLabel: JEV, answers: {} } as never;
	});
}

beforeEach(() => {
	vi.mocked(runClassifierTask).mockReset().mockResolvedValue(classifierVerdict(false));
	vi.mocked(runSystemOneTask).mockReset().mockResolvedValue({ status: 'not-assigned' });
	stores.settings = { localModelAssignments: { 'secret-screen': SOURCE } };
});

describe('screenOutbound: redaction', () => {
	it('redacts credential-shaped text and counts the texts it changed', async () => {
		const result = await screenOutbound(request('element', ['plain label', `key ${SLACK_TOKEN}`]), {
			env: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.texts[0]).toBe('plain label');
		expect(result.texts[1]).not.toContain(SLACK_TOKEN);
		expect(result.redactedCount).toBe(1);
	});
});

describe('screenOutbound: the pattern pass', () => {
	it('refuses credential-shaped text redaction leaves in place, naming the kind and the text', async () => {
		const screen = vi.fn(async () => ({
			findings: [
				{ kind: 'private-key' as const, line: 1, preview: '••••••••-KEY', source: 'text 2' },
			],
		}));
		const result = await screenOutbound(request('element', ['fine', 'not fine']), { screen });

		expect(result).toEqual({
			ok: false,
			kinds: ['private-key'],
			reason:
				'credential-shaped text in the element text: Private key (text 2). Remove it and retry. Nothing was written.',
		});
		// Patterns only, and nothing after a refusal.
		expect(screen).toHaveBeenCalledTimes(1);
		expect(screen.mock.calls[0]).toEqual([
			[
				{ source: 'text 1', text: 'fine' },
				{ source: 'text 2', text: 'not fine' },
			],
			{ modelPass: false },
		]);
	});

	it('refuses the value of a configured secret env var, which redaction cannot know', async () => {
		const result = await screenOutbound(request('element', [`deploy with ${CONFIGURED}`]), {
			env: ENV,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kinds).toEqual(['env-var-value']);
		expect(result.reason).toBe(
			'credential-shaped text in the element text: Configured secret. Remove it and retry. Nothing was written.'
		);
		expect(result.reason).not.toContain(CONFIGURED);
	});

	it('never sends a chat message with a configured secret to the model', async () => {
		const result = await screenOutbound(request('bot-reply', [`here: ${CONFIGURED}`]), {
			env: ENV,
		});

		expect(result).toMatchObject({ ok: false, kinds: ['env-var-value'] });
		expect(runSystemOneTask).not.toHaveBeenCalled();
		expect(runClassifierTask).not.toHaveBeenCalled();
	});
});

describe('screenOutbound: the model pass', () => {
	it('never runs for element writes', async () => {
		vi.mocked(runClassifierTask).mockResolvedValue(classifierVerdict(true));
		const result = await screenOutbound(request('element', ['a label', 'a note']), { env: [] });

		expect(result).toEqual({ ok: true, texts: ['a label', 'a note'], redactedCount: 0 });
		expect(runSystemOneTask).not.toHaveBeenCalled();
		expect(runClassifierTask).not.toHaveBeenCalled();
	});

	it('runs once per message for T12 and bot.reply, on all of its text', async () => {
		for (const purpose of ['chat', 'bot-reply'] as const) {
			vi.mocked(runClassifierTask).mockClear();
			const result = await screenOutbound(request(purpose, ['all done']), { env: [] });
			expect(result).toEqual({ ok: true, texts: ['all done'], redactedCount: 0 });
			expect(runClassifierTask).toHaveBeenCalledTimes(1);
			expect(vi.mocked(runClassifierTask).mock.calls[0][1].text).toBe('all done');
		}
	});

	it('holds a message the model flags, without refusing it', async () => {
		vi.mocked(runClassifierTask).mockResolvedValue(classifierVerdict(true));
		const result = await screenOutbound(request('bot-reply', ['the summary']), { env: [] });

		expect(result).toEqual({
			ok: true,
			texts: ['the summary'],
			redactedCount: 0,
			held: true,
			heldReason:
				'Flagged by Llama Prompt Guard 2 22M (MALICIOUS 0.91) as possibly holding a secret. The conductor can publish it anyway.',
		});
	});

	it('does not block on a model that cannot run: the note rides along', async () => {
		vi.mocked(runClassifierTask).mockResolvedValue({
			status: 'unavailable',
			code: 'not-installed',
			reason: 'The model is not installed.',
			source: SOURCE,
		} as never);
		const result = await screenOutbound(request('chat', ['hello room']), { env: [] });

		expect(result).toEqual({
			ok: true,
			texts: ['hello room'],
			redactedCount: 0,
			note: 'Secret screen model did not run: The model is not installed. Pattern detection still ran.',
		});
	});

	it('skips a cloud engine the room has no consent for, with a note', async () => {
		jevAssigned();
		const result = await screenOutbound(request('bot-reply', ['the summary']), {
			env: [],
			cloudPolicy: policy(false),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.held).toBeUndefined();
		expect(result.note).toContain('Screening on Jev (TypeSafe cloud) is not allowed');
		expect(runClassifierTask).not.toHaveBeenCalled();
	});

	it('asks a cloud engine the room consented to', async () => {
		jevAssigned();
		const allowed = vi.fn(() => true);
		const result = await screenOutbound(request('bot-reply', ['the summary']), {
			env: [],
			cloudPolicy: () => ({ ...policy(true)(), isCloudScreeningAllowed: allowed }),
		});

		expect(allowed).toHaveBeenCalledWith(
			'sk-1',
			expect.objectContaining({ kind: 'jev', locality: 'cloud' })
		);
		// The mocked engine's answer has no verdict, so the screen notes it.
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect(result.note).not.toContain('is not allowed');
	});
});
