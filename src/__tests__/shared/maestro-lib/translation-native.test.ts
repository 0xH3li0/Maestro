import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	extractNativeConversation,
	parseNativeLines,
} from '../../../shared/maestro-lib/translation/native-records';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('native-preserving extraction', () => {
	it('classifies recurring native evidence as info while keeping behavior loss as a warning', () => {
		const rows = [
			{
				type: 'user',
				uuid: 'user',
				cwd: identity.projectRoot,
				message: {
					role: 'user',
					content: embedSystemPromptInPrompt('Historical system rules', 'User request'),
				},
			},
			{
				type: 'assistant',
				uuid: 'assistant',
				cwd: '/later-directory',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: 'Opaque reasoning', signature: 'native-only' }],
				},
			},
			{ type: 'attachment', uuid: 'attachment' },
			{ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
		];
		const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		const bundle = extractNativeConversation(identity, 'tab', 'session', bytes);
		for (const code of [
			'opaque-runtime-state',
			'native-attachment-state',
			'historical-instructions',
			'native-cwd-drift',
		]) {
			expect(bundle.limitations).toContainEqual(
				expect.objectContaining({ code, severity: 'info' })
			);
		}
		expect(bundle.limitations).toContainEqual(
			expect.objectContaining({ code: 'native-boundary', severity: 'warning' })
		);
		expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
	});
	it('reads the synthetic native fixtures without collapsing identical user events', () => {
		for (const provider of ['claude-code', 'codex'] as const) {
			const fixture = path.resolve(
				'src/__tests__/fixtures/provider-translation',
				provider === 'codex' ? 'codex.jsonl' : 'claude.jsonl'
			);
			const bundle = extractNativeConversation(
				{ ...identity, provider },
				't',
				provider === 'codex' ? 'synthetic-codex' : 's',
				readFileSync(fixture)
			);
			expect(
				bundle.records.filter(
					(r) => r.role === 'user' && r.blocks.some((b) => b.kind === 'text' && b.text === 'repeat')
				)
			).toHaveLength(2);
			expect(bundle.limitations.some((l) => l.code === 'opaque-runtime-state')).toBe(true);
		}
	});
	it('preserves repeated messages, tools, images, parent chains, reasoning and unknown rows', () => {
		const rows = [
			{ uuid: 'a', type: 'user', message: { role: 'user', content: 'same' } },
			{ uuid: 'b', parentUuid: 'a', type: 'user', message: { role: 'user', content: 'same' } },
			{
				uuid: 'c',
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'synthetic.md' } },
						{ type: 'thinking', thinking: 'synthetic', signature: 'synthetic-signature' },
					],
				},
			},
			{
				uuid: 'd',
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'call', content: 'synthetic result' },
						{
							type: 'image',
							source: { type: 'base64', media_type: 'image/png', data: 'c3ludGhldGlj' },
						},
					],
				},
			},
			{ uuid: 'e', type: 'system', subtype: 'compact_boundary' },
			{ uuid: 'f', type: 'unknown', isSidechain: true },
		];
		const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
		const bundle = extractNativeConversation(identity, 'tab', 'session', bytes);
		expect(bundle.records).toHaveLength(6);
		expect(bundle.records[0].origin).not.toEqual(bundle.records[1].origin);
		expect(bundle.records[1].parentId).toBe('a');
		expect(bundle.records[3].blocks[0]).toMatchObject({ kind: 'tool-result', callId: 'call' });
		expect(bundle.artifacts).toHaveLength(2);
		expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		expect(bundle.limitations.some((l) => l.code === 'opaque-runtime-state')).toBe(true);
	});
	it('keeps Codex UI projections opaque and carries tool linkage and phase', () => {
		const rows = [
			{
				type: 'response_item',
				payload: {
					type: 'message',
					id: 'a',
					role: 'assistant',
					phase: 'commentary',
					content: [{ type: 'output_text', text: 'same' }],
				},
			},
			{ type: 'event_msg', payload: { type: 'agent_message', message: 'same' } },
			{
				type: 'response_item',
				payload: { type: 'function_call', id: 'b', name: 'read', call_id: 'call', arguments: '{}' },
			},
			{
				type: 'response_item',
				payload: { type: 'function_call_output', id: 'c', call_id: 'call', output: 'ok' },
			},
			{
				type: 'response_item',
				payload: { type: 'reasoning', id: 'd', encrypted_content: 'synthetic' },
			},
		];
		const result = extractNativeConversation(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			'tab',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))
		);
		expect(result.records[0].phase).toBe('commentary');
		expect(result.records[1].role).toBeUndefined();
		expect(result.records[2].blocks[0]).toMatchObject({ kind: 'tool-call', callId: 'call' });
		expect(result.records[4].native).toEqual(rows[4]);
	});
	it('archives embedded system envelopes without installing them as incoming instructions', () => {
		const text = embedSystemPromptInPrompt('Old provider system rules', 'Actual user request');
		const native = { type: 'user', uuid: 'enveloped', message: { role: 'user', content: text } };
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(JSON.stringify(native))
		);
		expect(bundle.records[0].blocks).toMatchObject([
			{ kind: 'opaque' },
			{ kind: 'text', text: 'Actual user request' },
		]);
		expect(bundle.records[0].native).toEqual(native);
	});

	it('still blocks mismatched project ownership when the tool tail was interrupted', () => {
		const row = {
			type: 'assistant',
			uuid: 'pending',
			cwd: '/another-project',
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'pending-call', name: 'Read', input: {} }],
			},
		};
		const bundle = extractNativeConversation(identity, 't', 's', Buffer.from(JSON.stringify(row)));
		expect(bundle.limitations.map((l) => l.code)).toEqual(
			expect.arrayContaining(['interrupted-tool-call-dropped', 'native-project-root-mismatch'])
		);
	});

	describe.each([
		{ provider: 'claude-code', custom: false },
		{ provider: 'codex', custom: false },
		{ provider: 'codex', custom: true },
	] as const)('$provider interrupted tools (custom: $custom)', ({ provider, custom }) => {
		it.each([
			{ laterRole: undefined, opaque: false },
			{ laterRole: 'user', opaque: false },
			{ laterRole: 'assistant', opaque: false },
			{ laterRole: 'user', opaque: true },
			{ laterRole: 'assistant', opaque: true },
		] as const)(
			'classifies an orphan with later role $laterRole (opaque: $opaque) without changing source evidence',
			({ laterRole, opaque }) => {
				const rows = [
					provider === 'claude-code'
						? {
								uuid: 'pending',
								type: 'assistant',
								message: {
									role: 'assistant',
									content: [{ type: 'tool_use', id: 'pending-call', name: 'Read', input: {} }],
								},
							}
						: {
								type: 'response_item',
								payload: {
									id: 'pending',
									type: custom ? 'custom_tool_call' : 'function_call',
									call_id: 'pending-call',
									name: 'Read',
									...(custom ? { input: 'synthetic' } : { arguments: '{}' }),
								},
							},
					...(laterRole
						? [
								provider === 'claude-code'
									? {
											uuid: 'later',
											type: laterRole,
											message: {
												role: laterRole,
												content: opaque
													? [{ type: 'future-content', data: 'Later conversation' }]
													: 'Later conversation',
											},
										}
									: {
											type: 'response_item',
											payload: {
												id: 'later',
												type: 'message',
												role: laterRole,
												content: opaque
													? [{ type: 'future-content', data: 'Later conversation' }]
													: [{ type: 'input_text', text: 'Later conversation' }],
											},
										},
							]
						: []),
					{ type: 'token_usage_record', data: { input_tokens: 12 } },
				];
				const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
				const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
				expect(bundle.records.map((record) => record.native)).toEqual(rows);
				expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
				expect(bundle.records[0].blocks[0]).toMatchObject({
					kind: 'tool-call',
					callId: 'pending-call',
					...(laterRole ? {} : { interrupted: true }),
				});
				if (laterRole) {
					expect(bundle.records[0].blocks[0]).not.toHaveProperty('interrupted');
					expect(bundle.limitations).toContainEqual(
						expect.objectContaining({ code: 'unfinished-tool-call', severity: 'block' })
					);
					expect(bundle.limitations.some((l) => l.code === 'interrupted-tool-call-dropped')).toBe(
						false
					);
				} else {
					expect(bundle.limitations.some((l) => l.severity === 'block')).toBe(false);
					expect(bundle.limitations).toContainEqual(
						expect.objectContaining({
							code: 'interrupted-tool-call-dropped',
							severity: 'warning',
							message: expect.stringContaining('pending-call'),
						})
					);
				}
			}
		);
	});

	describe.each(['claude-code', 'codex'] as const)('%s cwd ownership', (provider) => {
		it.each([
			{
				name: 'warns once for drift into subdirectories',
				origin: identity.projectRoot,
				later: [`${identity.projectRoot}/src`, `${identity.projectRoot}/docs`],
				blocked: false,
				drift: true,
			},
			{
				name: 'warns once for drift outside the project after a matching origin',
				origin: identity.projectRoot,
				later: ['/another-project', '/somewhere-else', identity.projectRoot],
				blocked: false,
				drift: true,
			},
			{
				name: 'accepts an origin inside the project',
				origin: `${identity.projectRoot}/src`,
				later: [`${identity.projectRoot}/src`],
				blocked: false,
				drift: false,
			},
			{
				name: 'blocks an outside origin even after returning to the project',
				origin: '/another-project',
				later: ['/another-project', identity.projectRoot],
				blocked: true,
				drift: true,
			},
			{
				name: 'blocks a similarly named sibling origin',
				origin: `${identity.projectRoot}-other`,
				later: [`${identity.projectRoot}-other`],
				blocked: true,
				drift: false,
			},
			{
				name: 'compares resolved paths without reporting equivalent cwds as drift',
				origin: `${identity.projectRoot}/src/..`,
				later: [identity.projectRoot, `${identity.projectRoot}/`],
				blocked: false,
				drift: false,
			},
		])('$name', ({ origin, later, blocked, drift }) => {
			const rows = [
				// Missing cwd on an earlier row must not hide the first declared origin.
				provider === 'claude-code'
					? { type: 'user', uuid: 'initial', message: { role: 'user', content: 'start' } }
					: {
							type: 'response_item',
							payload: {
								type: 'message',
								role: 'user',
								content: [{ type: 'input_text', text: 'start' }],
							},
						},
				...[origin, ...later].map((cwd, index) =>
					provider === 'claude-code'
						? {
								type: 'user',
								uuid: `cwd-${index}`,
								cwd,
								message: { role: 'user', content: 'continue' },
							}
						: {
								type: index === 0 ? 'session_meta' : 'turn_context',
								payload: { cwd, ...(index === 0 ? { id: 's' } : {}) },
							}
				),
			];
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
			const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
			expect(bundle.limitations.filter((l) => l.code === 'native-project-root-mismatch')).toEqual(
				blocked ? [expect.objectContaining({ severity: 'block', tabId: 't' })] : []
			);
			expect(bundle.limitations.filter((l) => l.code === 'native-cwd-drift')).toEqual(
				drift ? [expect.objectContaining({ severity: 'info', tabId: 't' })] : []
			);
			expect(bundle.limitations.filter((l) => l.severity === 'block')).toHaveLength(
				blocked ? 1 : 0
			);
			expect(bundle.records.map((record) => record.native)).toEqual(rows);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		});
	});

	it('uses Codex session metadata as the origin instead of another row cwd', () => {
		const rows = [
			{ type: 'turn_context', payload: { cwd: '/before-session-metadata' } },
			{ type: 'session_meta', payload: { id: 's', cwd: identity.projectRoot } },
			{ type: 'turn_context', payload: { cwd: identity.projectRoot } },
		];
		const bundle = extractNativeConversation(
			{ ...identity, provider: 'codex' },
			't',
			's',
			Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
		);
		expect(bundle.limitations.some((l) => l.code === 'native-project-root-mismatch')).toBe(false);
		expect(bundle.limitations.some((l) => l.code === 'native-cwd-drift')).toBe(false);
	});

	it.each(['claude-code', 'codex'] as const)(
		'blocks reversed and duplicated tool linkage in %s before native staging',
		(provider) => {
			const blocks = [
				{ kind: 'result', id: 'call' },
				{ kind: 'call', id: 'call' },
				{ kind: 'call', id: 'call' },
				{ kind: 'result', id: 'call' },
			];
			const rows = blocks.map((block, index) => {
				const role = block.kind === 'call' ? 'assistant' : 'user';
				return provider === 'claude-code'
					? {
							uuid: `event-${index}`,
							type: role,
							message: {
								role,
								content: [
									block.kind === 'call'
										? { type: 'tool_use', id: block.id, name: 'Read', input: {} }
										: { type: 'tool_result', tool_use_id: block.id, content: 'synthetic' },
								],
							},
						}
					: {
							type: 'response_item',
							payload: {
								id: `event-${index}`,
								call_id: block.id,
								...(block.kind === 'call'
									? { type: 'function_call', name: 'Read', arguments: '{}' }
									: { type: 'function_call_output', output: 'synthetic' }),
							},
						};
			});
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
			const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
			expect(bundle.limitations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: 'tool-result-order', severity: 'block' }),
					expect.objectContaining({ code: 'duplicate-tool-link', severity: 'block' }),
				])
			);
			expect(bundle.limitations.filter((l) => l.code === 'duplicate-tool-link')).toHaveLength(2);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		}
	);

	it('blocks Claude tools recorded under foreign roles and permits valid parallel calls', () => {
		const rows = [
			{
				type: 'assistant',
				uuid: 'calls',
				message: {
					role: 'assistant',
					content: ['one', 'two'].map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })),
				},
			},
			{
				type: 'user',
				uuid: 'results',
				message: {
					role: 'user',
					content: ['two', 'one'].map((id) => ({
						type: 'tool_result',
						tool_use_id: id,
						content: 'synthetic',
					})),
				},
			},
		];
		const validBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		expect(extractNativeConversation(identity, 't', 's', validBytes).limitations).toEqual([]);
		rows[0].message.role = 'user';
		rows[1].message.role = 'assistant';
		const invalidBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		const invalid = extractNativeConversation(identity, 't', 's', invalidBytes);
		expect(invalid.limitations.filter((l) => l.code === 'invalid-tool-role')).toHaveLength(4);
		expect(Buffer.from(invalid.artifacts[0].bytesBase64, 'base64')).toEqual(invalidBytes);
	});

	it('reports missing attachments, malformed records, duplicate IDs and orphan tool output', () => {
		const rows = [
			{
				uuid: 'a',
				type: 'user',
				message: {
					content: [
						{ type: 'image', source: { type: 'url', url: 'https://invalid.example/image' } },
						{ type: 'tool_result', tool_use_id: 'absent' },
					],
				},
			},
			{ uuid: 'a', type: 'unknown' },
		];
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n{broken')
		);
		expect(bundle.limitations.map((l) => l.code)).toEqual(
			expect.arrayContaining([
				'missing-attachment',
				'malformed-native-record',
				'duplicate-native-id',
				'broken-tool-link',
			])
		);
		expect(parseNativeLines(' {broken\n\n')).toMatchObject([{ malformed: true, entry: null }]);
	});
});
