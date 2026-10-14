// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import {
	projectConversation,
	createTranslationRegistry,
	codexTranslationAdapter,
} from '../../../shared/maestro-lib/translation/adapters';
import {
	importSelectedCodexResources,
	readCodexThreadItems,
	extractCodexItemHistory,
} from '../../../shared/maestro-lib/translation/codex-import';
import type { TranslationRpc } from '../../../shared/maestro-lib/translation/types';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('destination native projections', () => {
	it('refuses a Codex rollout parent symlink before injecting history', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-codex-target-'));
		try {
			const accountRoot = path.join(root, 'codex');
			const external = path.join(root, 'external');
			await fs.mkdir(accountRoot);
			await fs.mkdir(external);
			await fs.symlink(external, path.join(accountRoot, 'sessions'), 'dir');
			const request = vi.fn().mockResolvedValue({
				thread: { id: 'native', path: path.join(accountRoot, 'sessions', 'native.jsonl') },
			});
			const conversation = extractNativeConversation(
				identity,
				'tab',
				'source',
				Buffer.from(
					JSON.stringify({
						type: 'user',
						uuid: 'one',
						message: { role: 'user', content: 'synthetic' },
					})
				)
			);
			await expect(
				codexTranslationAdapter.stage(conversation, {
					operationId: 'operation',
					destination: { ...identity, provider: 'codex', version: '0.162.1', accountRoot },
					codex: { request, onNotification: () => () => {} },
					recordIntent: async () => {},
				})
			).rejects.toThrow('symlink');
			expect(request).toHaveBeenCalledTimes(1);
			expect(request.mock.calls[0][0]).toBe('thread/start');
			expect(await fs.readdir(external)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('reports archive-only assistant images before applying a Codex projection', () => {
		const conversation = extractNativeConversation(
			identity,
			'tab',
			'native',
			Buffer.from(
				JSON.stringify({
					type: 'assistant',
					uuid: 'image',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/png',
									data: Buffer.from('synthetic image').toString('base64'),
								},
							},
						],
					},
				})
			)
		);
		const plan = planTranslation({
			agentId: 'agent',
			source: identity,
			destination: { ...identity, provider: 'codex', version: '0.162.1' },
			scope: { projectKnowledge: true, selectedUserResources: [] },
			conversations: [conversation],
			registry: createTranslationRegistry(),
		});
		expect(plan.limitations).toContainEqual(
			expect.objectContaining({ code: 'assistant-attachment-projection', severity: 'warning' })
		);
	});
	it('archives installed paginated item records and blocks conversion without raw native evidence', () => {
		const entries = [
			{
				turnId: 'turn',
				item: { id: 'item', type: 'agentMessage', phase: 'final_answer', text: 'synthetic' },
			},
		];
		const snapshot = extractCodexItemHistory(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			't',
			'native',
			entries
		);
		expect(JSON.parse(Buffer.from(snapshot.artifacts[0].bytesBase64, 'base64').toString())).toEqual(
			entries
		);
		expect(snapshot.limitations[0]).toMatchObject({
			code: 'missing-native-rollout',
			severity: 'block',
		});
	});
	it('writes ordered tool history and excludes signed reasoning and historical system instructions', () => {
		const rows = [
			{
				uuid: 'a',
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'before' },
						{ type: 'tool_use', id: 'c', name: 'read', input: {} },
						{ type: 'text', text: 'after' },
						{ type: 'thinking', thinking: 'opaque', signature: 'never-forge' },
					],
				},
			},
			{
				uuid: 'b',
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'c', content: 'output' }],
				},
			},
		];
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))
		);
		const projected = projectConversation(bundle, 'codex', 'dest');
		expect(projected.map((r) => r.item.type)).toEqual([
			'message',
			'function_call',
			'message',
			'function_call_output',
		]);
		expect(JSON.stringify(projected)).not.toContain('never-forge');
		expect(projected[3].item.call_id).toBe('c');
		expect(projectConversation(bundle, 'codex', 'again')).toEqual(projected);
	});
	it('builds new Claude parent relationships without foreign reasoning signatures', () => {
		const bytes = Buffer.from(
			[
				{
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'one',
						role: 'user',
						content: [{ type: 'input_text', text: 'same' }],
					},
				},
				{
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'two',
						role: 'assistant',
						content: [{ type: 'output_text', text: 'same' }],
					},
				},
			]
				.map((r) => JSON.stringify(r))
				.join('\n')
		);
		const bundle = extractNativeConversation(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			't',
			's',
			bytes
		);
		const rows = projectConversation(bundle, 'claude-code', 'new-native');
		expect(rows[0].item.parentUuid).toBeNull();
		expect(rows[1].item.parentUuid).toBe(rows[0].id);
		expect(rows.every((r) => r.item.sessionId === 'new-native')).toBe(true);
		expect(createTranslationRegistry().get('opencode')).toBeUndefined();
	});
	it('refuses broad imports before sending RPC', async () => {
		const rpc = { request: vi.fn(), onNotification: vi.fn() } as unknown as TranslationRpc;
		await expect(
			importSelectedCodexResources(rpc, '/project', [
				{ cwd: '', itemType: 'MEMORY', description: 'unsafe', details: { memory: [] } },
			])
		).rejects.toThrow('Unsafe broad');
		expect(rpc.request).not.toHaveBeenCalled();
	});
	it('awaits asynchronous completion even when it arrives before the import response', async () => {
		let listener!: (method: string, params: unknown) => void;
		const remove = vi.fn();
		const rpc: TranslationRpc = {
			onNotification: (fn) => {
				listener = fn;
				return remove;
			},
			request: async <T>() => {
				listener('externalAgentConfig/import/completed', {
					importId: 'i',
					itemTypeResults: [{ itemType: 'MEMORY', successes: [], failures: [] }],
				});
				return { importId: 'i' } as T;
			},
		};
		const result = await importSelectedCodexResources(rpc, '/project', [
			{
				cwd: '/project',
				itemType: 'MEMORY',
				description: 'selected',
				details: { memory: ['topic.md'] },
			},
		]);
		expect(result.importId).toBe('i');
		expect(remove).toHaveBeenCalled();
	});
	it('reads all native history pages and detects a repeated cursor', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: [{ id: 'a' }], nextCursor: 'next' })
			.mockResolvedValueOnce({ data: [{ id: 'b' }] });
		expect(
			await readCodexThreadItems({ request, onNotification: () => () => {} }, 'native')
		).toEqual([{ id: 'a' }, { id: 'b' }]);
		expect(request.mock.calls[1][1].cursor).toBe('next');
	});
});
