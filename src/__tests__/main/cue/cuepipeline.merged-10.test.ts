// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-pipeline-rename.test.ts
//   - src/__tests__/main/cue/cue-dispatch-service.test.ts
//   - src/__tests__/main/cue/cue-template-context-builder.test.ts
//   - src/__tests__/main/cue/cue-template-context-builder.upstream.test.ts
//   - src/__tests__/main/cue/cue-electron-imports.test.ts

import { createCueDispatchService } from '../../../main/cue/cue-dispatch-service';
import type { CueDispatchServiceDeps } from '../../../main/cue/cue-dispatch-service';
import {
	MAX_PIPELINE_NAME_LENGTH,
	renamePipelineCommentHeader,
	renamePipelineOnDisk,
	validatePipelineName,
} from '../../../main/cue/cue-pipeline-rename';
import { buildCueTemplateContext } from '../../../main/cue/cue-template-context-builder';
import { createCueEvent } from '../../../main/cue/cue-types';
import type {
	CueEvent,
	CueSubscription as CueSubscription_1,
	CueSubscription as CueSubscription_2,
} from '../../../main/cue/cue-types';
import type { CueSubscription } from '../../../shared/cue';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layoutState = vi.hoisted(() => ({
	value: null as { pipelines: Array<{ id: string; name: string }> } | null,
	saved: null as { pipelines: Array<{ id: string; name: string }> } | null,
	throwOnSave: false,
}));
vi.mock('../../../main/cue/pipeline-layout-store', () => ({
	loadPipelineLayout: () => layoutState.value,
	savePipelineLayout: (next: { pipelines: Array<{ id: string; name: string }> }) => {
		if (layoutState.throwOnSave) throw new Error('disk full');
		layoutState.saved = next;
	},
}));

// ===== from src/__tests__/main/cue/cue-pipeline-rename.test.ts =====

function writeConfig(projectRoot: string, contents: string): string {
	const dir = path.join(projectRoot, '.maestro');
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, 'cue.yaml');
	fs.writeFileSync(filePath, contents, 'utf-8');
	return filePath;
}

function readSubs(projectRoot: string): Record<string, unknown>[] {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
	return (parsed.subscriptions ?? []) as Record<string, unknown>[];
}

function readRaw(projectRoot: string): string {
	return fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8');
}

describe('cue-pipeline-rename', () => {
	const roots: string[] = [];

	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-rename-'));
		roots.push(root);
		return root;
	}

	beforeEach(() => {
		layoutState.value = null;
		layoutState.saved = null;
		layoutState.throwOnSave = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (roots.length > 0) {
			const root = roots.pop()!;
			if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
		}
	});

	describe('validatePipelineName', () => {
		it('accepts an ordinary name', () => {
			expect(validatePipelineName('ODIN Weekly')).toEqual({ ok: true });
		});

		it('rejects an empty or whitespace-only name', () => {
			expect(validatePipelineName('')).toMatchObject({ ok: false });
			expect(validatePipelineName('   ')).toMatchObject({ ok: false });
		});

		// `::` is the separator in the remote subscription id, so a name holding
		// one produces ids that cannot be parsed back apart.
		it('rejects "::"', () => {
			expect(validatePipelineName('a::b')).toMatchObject({ ok: false });
		});

		it('rejects a line break, which would corrupt the comment header', () => {
			expect(validatePipelineName('two\nlines')).toMatchObject({ ok: false });
		});

		it('rejects a name past the length cap', () => {
			expect(validatePipelineName('x'.repeat(MAX_PIPELINE_NAME_LENGTH))).toEqual({ ok: true });
			expect(validatePipelineName('x'.repeat(MAX_PIPELINE_NAME_LENGTH + 1))).toMatchObject({
				ok: false,
			});
		});
	});

	describe('renamePipelineOnDisk', () => {
		it('rewrites pipeline_name on every member', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{ name: 'Old-chain-2', event: 'agent.completed', pipeline_name: 'Old', prompt: 'b' },
					],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.subscriptionsUpdated).toBe(2);
			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'New']);
		});

		// Subscription names are stable identities - the layout store keys trigger
		// positions by them and `source_sub` points at them. Renaming them here
		// would strand both, which is exactly the bug this guards.
		it('leaves subscription names and their cross-references untouched', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{
							name: 'Old-chain-2',
							event: 'agent.completed',
							pipeline_name: 'Old',
							source_sub: 'Old',
							prompt: 'b',
						},
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const subs = readSubs(root);
			expect(subs.map((s) => s.name)).toEqual(['Old', 'Old-chain-2']);
			expect(subs[1].source_sub).toBe('Old');
		});

		it('preserves fields it has no business touching', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					settings: { max_concurrent: 3 },
					subscriptions: [
						{
							name: 'Old',
							event: 'time.scheduled',
							pipeline_name: 'Old',
							pipeline_color: '#06b6d4',
							schedule_times: ['09:00'],
							prompt: 'do the thing',
							enabled: false,
						},
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const parsed = yaml.load(readRaw(root)) as Record<string, unknown>;
			expect(parsed.settings).toEqual({ max_concurrent: 3 });
			expect(readSubs(root)[0]).toMatchObject({
				name: 'Old',
				pipeline_color: '#06b6d4',
				schedule_times: ['09:00'],
				prompt: 'do the thing',
				enabled: false,
			});
		});

		// A cross-agent pipeline is physically N files; renaming only the root you
		// happened to click would split it in half.
		it('rewrites every root the pipeline spans', () => {
			const rootA = makeRoot();
			const rootB = makeRoot();
			for (const root of [rootA, rootB]) {
				writeConfig(
					root,
					yaml.dump({
						subscriptions: [
							{ name: `sub-${root}`, event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						],
					})
				);
			}

			const result = renamePipelineOnDisk([rootA, rootB], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(2);
			expect(result.filesWritten).toHaveLength(2);
			expect(readSubs(rootA)[0].pipeline_name).toBe('New');
			expect(readSubs(rootB)[0].pipeline_name).toBe('New');
		});

		it('leaves other pipelines in the same file alone', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{ name: 'Other', event: 'time.scheduled', pipeline_name: 'Other', prompt: 'b' },
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'Other']);
		});

		// Legacy YAML groups by the `-chain-N` suffix convention when no
		// `pipeline_name` is present. Renaming has to find those members AND stamp
		// the field, or they would be orphaned the moment the name stops matching.
		it('finds legacy members grouped only by name suffix, and stamps the field', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', prompt: 'a' },
						{ name: 'Old-chain-2', event: 'agent.completed', prompt: 'b' },
						{ name: 'Old-fanin', event: 'agent.completed', prompt: 'c' },
					],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(3);
			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'New', 'New']);
			// Names still unchanged, so the suffix no longer matches - which is
			// precisely why the field had to be written.
			expect(readSubs(root).map((s) => s.name)).toEqual(['Old', 'Old-chain-2', 'Old-fanin']);
		});

		it('does not rewrite a file that holds no member of the pipeline', () => {
			const root = makeRoot();
			const filePath = writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Other', event: 'time.scheduled', pipeline_name: 'Other', prompt: 'b' },
					],
				})
			);
			const before = fs.readFileSync(filePath, 'utf-8');

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(false);
			expect(result.filesWritten).toEqual([]);
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		});

		it('reports a miss rather than claiming success', () => {
			const root = makeRoot();
			writeConfig(root, yaml.dump({ subscriptions: [] }));

			const result = renamePipelineOnDisk([root], 'Nope', 'New');

			expect(result.renamed).toBe(false);
			expect(result.reason).toContain('no subscriptions found');
		});

		it('refuses an invalid name before touching anything', () => {
			const root = makeRoot();
			const filePath = writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			const before = fs.readFileSync(filePath, 'utf-8');

			const result = renamePipelineOnDisk([root], 'Old', '   ');

			expect(result.renamed).toBe(false);
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		});

		it('treats an unchanged name as a no-op, not an error state', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'Old');

			expect(result.renamed).toBe(false);
			expect(result.reason).toBe('the name is unchanged');
		});

		it('trims the new name', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			renamePipelineOnDisk([root], 'Old', '  New  ');

			expect(readSubs(root)[0].pipeline_name).toBe('New');
		});

		// Two agents can share one project root; counting the file twice would
		// report a subscription count the user cannot reconcile with their YAML.
		it('does not double-count a root passed twice', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([root, root], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(1);
			expect(result.filesWritten).toHaveLength(1);
		});

		it('warns and keeps going when one root is unparseable', () => {
			const bad = makeRoot();
			const good = makeRoot();
			writeConfig(bad, 'subscriptions: [oops\n  bad: : yaml');
			writeConfig(
				good,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([bad, good], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings.some((w) => w.includes('could not parse'))).toBe(true);
			expect(readSubs(good)[0].pipeline_name).toBe('New');
		});

		it('skips a root with no cue.yaml without warning about it', () => {
			const empty = makeRoot();
			const good = makeRoot();
			writeConfig(
				good,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([empty, good], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings).toEqual([]);
		});

		it('preserves the leading comment header', () => {
			const root = makeRoot();
			writeConfig(
				root,
				`# Maestro Cue config\n# Pipeline: Old (color: #06b6d4)\n\n${yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})}`
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const raw = readRaw(root);
			expect(raw).toContain('# Maestro Cue config');
			// The header names the pipeline, so it has to move with the rename.
			expect(raw).toContain('# Pipeline: New (color: #06b6d4)');
			expect(raw).not.toContain('# Pipeline: Old');
		});

		// The visual pipeline id is derived from the name, so without the re-key
		// the renamed pipeline reloads with no remembered node positions and the
		// old entry lingers as an orphan.
		it('re-keys the saved layout entry', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			layoutState.value = {
				pipelines: [
					{ id: 'pipeline-Old', name: 'Old' },
					{ id: 'pipeline-Other', name: 'Other' },
				],
			};

			renamePipelineOnDisk([root], 'Old', 'New');

			expect(layoutState.saved?.pipelines).toEqual([
				{ id: 'pipeline-New', name: 'New' },
				{ id: 'pipeline-Other', name: 'Other' },
			]);
		});

		// The YAML rename has already landed by then, so a layout failure is a
		// warning about lost node positions - not a failed rename.
		it('still reports success when the layout re-key fails', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			layoutState.value = { pipelines: [{ id: 'pipeline-Old', name: 'Old' }] };
			layoutState.throwOnSave = true;

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings.some((w) => w.includes('node positions'))).toBe(true);
			expect(readSubs(root)[0].pipeline_name).toBe('New');
		});
	});

	describe('renamePipelineCommentHeader', () => {
		it('rewrites an exact match and keeps the color suffix', () => {
			expect(renamePipelineCommentHeader('# Pipeline: Old (color: #06b6d4)\n', 'Old', 'New')).toBe(
				'# Pipeline: New (color: #06b6d4)\n'
			);
		});

		it('rewrites a header with no color suffix', () => {
			expect(renamePipelineCommentHeader('# Pipeline: Old\n', 'Old', 'New')).toBe(
				'# Pipeline: New\n'
			);
		});

		// A comment that merely mentions the word is not a declaration of it.
		it('leaves a different pipeline and prose mentions alone', () => {
			const header = '# Pipeline: Other\n# Old is mentioned here\n';
			expect(renamePipelineCommentHeader(header, 'Old', 'New')).toBe(header);
		});

		it('is a no-op on an empty header', () => {
			expect(renamePipelineCommentHeader('', 'Old', 'New')).toBe('');
		});
	});
});

// ===== from src/__tests__/main/cue/cue-dispatch-service.test.ts =====

function makeDeps(
	sessionsByName: Array<{ id: string; name: string }> = [
		{ id: 's-1', name: 'alpha' },
		{ id: 's-2', name: 'bravo' },
	]
): {
	deps: CueDispatchServiceDeps;
	executeRun: ReturnType<typeof vi.fn>;
	logs: Array<[string, string]>;
} {
	const logs: Array<[string, string]> = [];
	const executeRun = vi.fn();
	const deps: CueDispatchServiceDeps = {
		getSessions: () => sessionsByName,
		executeRun: executeRun as CueDispatchServiceDeps['executeRun'],
		onLog: (level, message) => {
			logs.push([level, message]);
		},
	};
	return { deps, executeRun, logs };
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'my-sub',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'default prompt',
		...overrides,
	};
}

describe('createCueDispatchService', () => {
	describe('single-target', () => {
		it('returns 1 and dispatches when sub has a prompt', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: 'hello' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledTimes(1);
		});

		it('returns 0 and warns when prompt is empty', () => {
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: '' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			expect(executeRun).not.toHaveBeenCalled();
			expect(logs.some(([level, msg]) => level === 'warn' && /no prompt/.test(msg))).toBe(true);
		});

		it('uses promptOverride when provided', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: '' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src', 0, 'override!');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				'owner',
				'override!',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined, // chainRootId
				undefined, // parentEventId
				undefined // notify
			);
		});
	});

	describe('fan-out', () => {
		it('returns 2 when both targets have prompts', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['for alpha', 'for bravo'],
				prompt: 'fallback',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(2);
			expect(executeRun).toHaveBeenCalledTimes(2);
			expect(executeRun.mock.calls[0][1]).toBe('for alpha');
			expect(executeRun.mock.calls[1][1]).toBe('for bravo');
		});

		it('returns 1 and warns when only one fan-out target has a prompt', () => {
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['for alpha', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledTimes(1);
			expect(logs.some(([level, msg]) => level === 'warn' && /has no prompt/.test(msg))).toBe(true);
		});

		it('returns 0 and emits an error log when every fan-out target is skipped', () => {
			// This is the "manual trigger with 2 agents does nothing" scenario
			// the user reported: both agents had empty prompts due to the earlier
			// debounce race, so fan-out skipped both without any user-visible feedback.
			// Now the dispatcher emits an error log naming every skipped target.
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			expect(executeRun).not.toHaveBeenCalled();
			const errorLog = logs.find(([level]) => level === 'error');
			expect(errorLog).toBeDefined();
			expect(errorLog![1]).toMatch(/no fan-out targets ran/);
			expect(errorLog![1]).toMatch(/alpha \(empty prompt\)/);
			expect(errorLog![1]).toMatch(/bravo \(empty prompt\)/);
		});

		it('tracks not-found targets alongside empty-prompt targets', () => {
			const { deps, logs } = makeDeps([{ id: 's-1', name: 'alpha' }]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'ghost'],
				fan_out_prompts: ['', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			const errorLog = logs.find(([level]) => level === 'error');
			expect(errorLog![1]).toMatch(/alpha \(empty prompt\)/);
			expect(errorLog![1]).toMatch(/ghost \(not found\)/);
		});

		// `fan_out` carries the display name at save time; renaming an agent
		// would otherwise silently drop it from dispatch (the YAML name no
		// longer matches any live session). `fan_out_ids` is the stable-id
		// mirror - the dispatcher must prefer it over the stale name.
		it('resolves fan-out target by fan_out_ids when the agent has been renamed', () => {
			const { deps, executeRun } = makeDeps([
				// Renamed: id is still 's-1', name is now 'alpha-renamed'.
				{ id: 's-1', name: 'alpha-renamed' },
			]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha'], // stale display name from YAML
				fan_out_ids: ['s-1'], // stable id
				prompt: 'hello',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				's-1',
				'hello',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined, // chainRootId
				undefined // parentEventId
			);
		});

		it('falls back to name match when fan_out_ids is absent (legacy YAML)', () => {
			const { deps, executeRun } = makeDeps([{ id: 's-1', name: 'alpha' }]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha'],
				prompt: 'hello',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				's-1',
				'hello',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined, // chainRootId
				undefined // parentEventId
			);
		});
	});

	describe('action: notify', () => {
		it('resolves the toast body from notify.message and threads sticky through', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				action: 'notify',
				agent_id: 's-1',
				prompt: '',
				notify: { message: 'Standup in 5', sticky: true },
			});
			const event = createCueEvent('time.once', 'my-sub');

			const dispatched = svc.dispatchSubscription('s-1', sub, event, 'src');

			expect(dispatched).toBe(1);
			const args = executeRun.mock.calls[0];
			// prompt slot carries the resolved message
			expect(args[1]).toBe('Standup in 5');
			// notify config arrives at position 13 with the resolved message and sticky
			expect(args[12]).toEqual({ message: 'Standup in 5', sticky: true });
		});

		it('falls back to label when notify.message is missing', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				action: 'notify',
				agent_id: 's-1',
				prompt: '',
				label: 'Coffee time',
				notify: {},
			});
			const event = createCueEvent('time.once', 'my-sub');

			svc.dispatchSubscription('s-1', sub, event, 'src');

			const args = executeRun.mock.calls[0];
			expect(args[1]).toBe('Coffee time');
			expect(args[12]).toEqual({ message: 'Coffee time' });
		});

		it('falls back to prompt then name when neither notify.message nor label is set', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				action: 'notify',
				agent_id: 's-1',
				prompt: 'inline prompt body',
				notify: {},
			});
			const event = createCueEvent('time.once', 'my-sub');

			svc.dispatchSubscription('s-1', sub, event, 'src');
			expect(executeRun.mock.calls[0][1]).toBe('inline prompt body');

			executeRun.mockClear();
			const subNoPrompt = makeSub({
				name: 'standup',
				action: 'notify',
				agent_id: 's-1',
				prompt: '',
				notify: {},
			});
			svc.dispatchSubscription('s-1', subNoPrompt, event, 'src');
			expect(executeRun.mock.calls[0][1]).toBe('standup');
		});

		it('dispatches notify subs even when prompt is empty (no "no prompt" skip)', () => {
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				action: 'notify',
				agent_id: 's-1',
				prompt: '',
				notify: { message: 'Hello' },
			});
			const event = createCueEvent('time.once', 'my-sub');

			const dispatched = svc.dispatchSubscription('s-1', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledTimes(1);
			expect(logs.some(([level, msg]) => level === 'warn' && /no prompt/.test(msg))).toBe(false);
		});
	});

	describe('onTriggerFired (cue.fired plugin hook)', () => {
		it('fires once per dispatch with the source event TYPE only (no prompt text)', () => {
			const { deps } = makeDeps();
			const onTriggerFired = vi.fn();
			const svc = createCueDispatchService({ ...deps, onTriggerFired });
			const sub = makeSub({ prompt: 'secret prompt body that must never leak' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			svc.dispatchSubscription('owner', sub, event, 'src');

			expect(onTriggerFired).toHaveBeenCalledTimes(1);
			expect(onTriggerFired).toHaveBeenCalledWith('time.heartbeat');
			// Exactly one string arg - no object/extra args that could carry a prompt.
			const call = onTriggerFired.mock.calls[0];
			expect(call).toHaveLength(1);
			expect(typeof call[0]).toBe('string');
		});

		it('fires once for a fan-out dispatch (per subscription, not per target)', () => {
			const { deps } = makeDeps();
			const onTriggerFired = vi.fn();
			const svc = createCueDispatchService({ ...deps, onTriggerFired });
			const sub = makeSub({ fan_out: ['alpha', 'bravo'], prompt: 'p' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			svc.dispatchSubscription('owner', sub, event, 'src');

			expect(onTriggerFired).toHaveBeenCalledTimes(1);
			expect(onTriggerFired).toHaveBeenCalledWith('time.heartbeat');
		});
	});
});

// ===== from src/__tests__/main/cue/cue-template-context-builder.test.ts =====

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'file.changed',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'test-trigger',
		payload: {},
		...overrides,
	};
}

function createSubscription(overrides: Partial<CueSubscription_1> = {}): CueSubscription_1 {
	return {
		name: 'test-sub',
		event: 'file.changed',
		enabled: true,
		prompt: 'test prompt',
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-template-context-builder', () => {
	describe('base enricher (all event types)', () => {
		it('populates common fields from event metadata', () => {
			const event = createEvent({
				type: 'time.heartbeat',
				timestamp: '2026-04-10T12:00:00.000Z',
			});
			const sub = createSubscription({ name: 'heartbeat-check' });

			const ctx = buildCueTemplateContext(event, sub, 'run-abc');

			expect(ctx.eventType).toBe('time.heartbeat');
			expect(ctx.eventTimestamp).toBe('2026-04-10T12:00:00.000Z');
			expect(ctx.triggerName).toBe('heartbeat-check');
			expect(ctx.runId).toBe('run-abc');
		});

		it('populates file fields from payload', () => {
			const event = createEvent({
				payload: {
					path: '/project/src/app.ts',
					filename: 'app.ts',
					directory: '/project/src',
					extension: '.ts',
					changeType: 'change',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.filePath).toBe('/project/src/app.ts');
			expect(ctx.fileName).toBe('app.ts');
			expect(ctx.fileDir).toBe('/project/src');
			expect(ctx.fileExt).toBe('.ts');
			expect(ctx.fileChangeType).toBe('change');
		});

		it('populates agent.completed source fields from payload', () => {
			const event = createEvent({
				type: 'agent.completed',
				payload: {
					sourceSession: 'builder',
					sourceOutput: 'Build OK',
					status: 'completed',
					exitCode: 0,
					durationMs: 5000,
					triggeredBy: 'file-watch',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceSession).toBe('builder');
			expect(ctx.sourceOutput).toBe('Build OK');
			expect(ctx.sourceStatus).toBe('completed');
			expect(ctx.sourceExitCode).toBe('0');
			expect(ctx.sourceDuration).toBe('5000');
			expect(ctx.sourceTriggeredBy).toBe('file-watch');
		});

		it('defaults all fields to empty string when payload is empty', () => {
			const event = createEvent({ payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.filePath).toBe('');
			expect(ctx.fileName).toBe('');
			expect(ctx.fileDir).toBe('');
			expect(ctx.fileExt).toBe('');
			expect(ctx.fileChangeType).toBe('');
			expect(ctx.sourceSession).toBe('');
			expect(ctx.sourceOutput).toBe('');
			expect(ctx.sourceStatus).toBe('');
			expect(ctx.sourceExitCode).toBe('');
			expect(ctx.sourceDuration).toBe('');
			expect(ctx.sourceTriggeredBy).toBe('');
		});
	});

	describe('task.pending enricher', () => {
		it('populates task-specific fields', () => {
			const event = createEvent({
				type: 'task.pending',
				payload: {
					path: '/project/TODO.md',
					filename: 'TODO.md',
					directory: '/project',
					taskCount: 3,
					taskList: '- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3',
					content: '# TODO\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.taskFile).toBe('/project/TODO.md');
			expect(ctx.taskFileName).toBe('TODO.md');
			expect(ctx.taskFileDir).toBe('/project');
			expect(ctx.taskCount).toBe('3');
			expect(ctx.taskList).toBe('- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3');
			expect(ctx.taskContent).toBe('# TODO\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3');
		});

		it('preserves base cue fields alongside task fields', () => {
			const event = createEvent({
				type: 'task.pending',
				timestamp: '2026-04-10T15:00:00.000Z',
				payload: { taskCount: 1, taskList: '- [ ] One' },
			});
			const sub = createSubscription({ name: 'task-watcher' });

			const ctx = buildCueTemplateContext(event, sub, 'run-2');

			// Base fields present
			expect(ctx.eventType).toBe('task.pending');
			expect(ctx.triggerName).toBe('task-watcher');
			expect(ctx.runId).toBe('run-2');
			// Task fields present
			expect(ctx.taskCount).toBe('1');
		});

		it('defaults task fields to empty/zero when payload is missing', () => {
			const event = createEvent({ type: 'task.pending', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.taskFile).toBe('');
			expect(ctx.taskFileName).toBe('');
			expect(ctx.taskFileDir).toBe('');
			expect(ctx.taskCount).toBe('0');
			expect(ctx.taskList).toBe('');
			expect(ctx.taskContent).toBe('');
		});
	});

	describe('github.pull_request enricher', () => {
		it('populates GitHub PR fields', () => {
			const event = createEvent({
				type: 'github.pull_request',
				payload: {
					type: 'pull_request',
					number: 42,
					title: 'Add feature X',
					author: 'octocat',
					url: 'https://github.com/owner/repo/pull/42',
					body: 'This PR adds feature X',
					labels: 'enhancement,review-needed',
					state: 'open',
					repo: 'owner/repo',
					head_branch: 'feature-x',
					base_branch: 'main',
					assignees: 'dev1',
					merged_at: '',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.ghType).toBe('pull_request');
			expect(ctx.ghNumber).toBe('42');
			expect(ctx.ghTitle).toBe('Add feature X');
			expect(ctx.ghAuthor).toBe('octocat');
			expect(ctx.ghUrl).toBe('https://github.com/owner/repo/pull/42');
			expect(ctx.ghBody).toBe('This PR adds feature X');
			expect(ctx.ghLabels).toBe('enhancement,review-needed');
			expect(ctx.ghState).toBe('open');
			expect(ctx.ghRepo).toBe('owner/repo');
			expect(ctx.ghBranch).toBe('feature-x');
			expect(ctx.ghBaseBranch).toBe('main');
			expect(ctx.ghAssignees).toBe('dev1');
			expect(ctx.ghMergedAt).toBe('');
		});

		it('preserves base cue fields alongside GitHub fields', () => {
			const event = createEvent({
				type: 'github.pull_request',
				payload: { number: 1, title: 'Test' },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('github.pull_request');
			expect(ctx.ghNumber).toBe('1');
		});
	});

	describe('github.issue enricher', () => {
		it('populates GitHub issue fields', () => {
			const event = createEvent({
				type: 'github.issue',
				payload: {
					type: 'issue',
					number: 99,
					title: 'Bug report',
					author: 'user1',
					url: 'https://github.com/owner/repo/issues/99',
					body: 'Found a bug',
					labels: 'bug',
					state: 'open',
					repo: 'owner/repo',
					assignees: 'dev1,dev2',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.ghType).toBe('issue');
			expect(ctx.ghNumber).toBe('99');
			expect(ctx.ghTitle).toBe('Bug report');
			expect(ctx.ghAssignees).toBe('dev1,dev2');
			// head_branch / base_branch not in payload → empty string
			expect(ctx.ghBranch).toBe('');
			expect(ctx.ghBaseBranch).toBe('');
		});
	});

	describe('unknown event types', () => {
		it('still returns base fields for unregistered event types', () => {
			const event = createEvent({
				type: 'app.startup' as any,
				timestamp: '2026-04-10T08:00:00.000Z',
			});
			const sub = createSubscription({ name: 'boot-task' });

			const ctx = buildCueTemplateContext(event, sub, 'run-5');

			// Base fields always populated
			expect(ctx.eventType).toBe('app.startup');
			expect(ctx.triggerName).toBe('boot-task');
			expect(ctx.runId).toBe('run-5');
			// No event-specific enricher for app.startup, so no extra fields
			expect(ctx.taskFile).toBeUndefined();
			expect(ctx.ghType).toBeUndefined();
		});

		it('handles time.heartbeat (no specific enricher) gracefully', () => {
			const event = createEvent({ type: 'time.heartbeat', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('time.heartbeat');
			expect(ctx.filePath).toBe('');
		});

		it('handles time.scheduled (no specific enricher) gracefully', () => {
			const event = createEvent({ type: 'time.scheduled', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('time.scheduled');
		});
	});

	describe('edge cases', () => {
		it('coerces numeric payload values to strings', () => {
			const event = createEvent({
				type: 'agent.completed',
				payload: { exitCode: 137, durationMs: 0 },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceExitCode).toBe('137');
			expect(ctx.sourceDuration).toBe('0');
		});

		it('coerces boolean payload values to strings', () => {
			const event = createEvent({
				payload: { status: false as any },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceStatus).toBe('false');
		});
	});
});

// ===== from src/__tests__/main/cue/cue-template-context-builder.upstream.test.ts =====

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub_1(overrides: Partial<CueSubscription_2> = {}): CueSubscription_2 {
	return {
		name: 'test-sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'test',
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue-template-context-builder - per-source upstream output', () => {
	describe('perSourceOutputs', () => {
		it('creates output_ keys for each source in perSourceOutputs', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'Agent A': 'output-a',
					'Agent B': 'output-b',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.output_AGENT_A).toBe('output-a');
			expect(ctx.output_AGENT_B).toBe('output-b');
		});

		it('does not add output_ keys when perSourceOutputs is absent', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				sourceSession: 'worker',
				sourceOutput: 'done',
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			// No output_* keys should exist (except base fields)
			const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
			expect(outputKeys).toHaveLength(0);
		});

		it('handles empty perSourceOutputs map', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
			expect(outputKeys).toHaveLength(0);
		});
	});

	describe('forwardedOutputs', () => {
		it('creates forwarded_ keys for each source in forwardedOutputs', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				forwardedOutputs: {
					'Agent C': 'forwarded-c',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.forwarded_AGENT_C).toBe('forwarded-c');
		});

		it('does not add forwarded_ keys when forwardedOutputs is absent', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			const forwardedKeys = Object.keys(ctx).filter((k) => k.startsWith('forwarded_'));
			expect(forwardedKeys).toHaveLength(0);
		});
	});

	describe('name sanitization', () => {
		it('sanitizes special characters in session names to underscores', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'my-agent.1': 'output-special',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.output_MY_AGENT_1).toBe('output-special');
		});

		it('sanitizes names with multiple special characters', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'agent--with...dots': 'value',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			// Multiple non-alphanumeric chars collapse to a single underscore
			expect(ctx.output_AGENT_WITH_DOTS).toBe('value');
		});

		it('strips leading and trailing non-alphanumeric from sanitized names', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'-leading-': 'val',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.output_LEADING).toBe('val');
		});

		it('uppercases lowercase names', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				forwardedOutputs: {
					'lowercase agent': 'fwd',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.forwarded_LOWERCASE_AGENT).toBe('fwd');
		});
	});

	describe('combined perSourceOutputs + forwardedOutputs', () => {
		it('includes both output_ and forwarded_ keys when both maps are present', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'Agent A': 'output-a',
				},
				forwardedOutputs: {
					'Agent B': 'forwarded-b',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			expect(ctx.output_AGENT_A).toBe('output-a');
			expect(ctx.forwarded_AGENT_B).toBe('forwarded-b');
		});

		it('preserves base fields alongside per-source fields', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				sourceSession: 'Agent A',
				sourceOutput: 'combined output',
				perSourceOutputs: {
					'Agent A': 'per-source-a',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub_1(), 'run-1');

			// Base source fields
			expect(ctx.sourceSession).toBe('Agent A');
			expect(ctx.sourceOutput).toBe('combined output');
			// Per-source field
			expect(ctx.output_AGENT_A).toBe('per-source-a');
		});
	});
});

// ===== from src/__tests__/main/cue/cue-electron-imports.test.ts =====

const CUE_DIR = path.join(__dirname, '../../../main/cue');

/** Files that still reach for Electron, and why. Shrink this, never grow it. */
const KNOWN_ELECTRON_IMPORTERS = [
	'backup/cue-backup-manager.ts', // app.getPath for the backup directory
	'cue-auth-detector.ts', // type-only: BrowserWindow for the re-auth prompt
	'cue-notify-bridge.ts', // BrowserWindow for toast delivery
	'cue-notify-executor.ts', // BrowserWindow for toast delivery
];

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.name.endsWith('.ts') ? [full] : [];
	});
}

describe('Cue engine Electron coupling', () => {
	// Covers both quote styles, `require`, and a dynamic `import()`, so the
	// ratchet cannot be stepped around by changing the syntax.
	// The trailing `(?:\/[^'"]*)?` catches subpath imports like `electron/main`,
	// which the bare form would let through.
	const ELECTRON_REF = /(?:from|require\(|import\()\s*['"]electron(?:\/[^'"]*)?['"]/;

	// `path.relative` emits native separators, so a nested entry reads
	// `backup\cue-backup-manager.ts` on Windows and matches nothing in the list
	// above. Normalize to forward slashes rather than spelling the list twice.
	const importers = walk(CUE_DIR)
		.filter((file) => ELECTRON_REF.test(fs.readFileSync(file, 'utf-8')))
		.map((file) => path.relative(CUE_DIR, file).split(path.sep).join('/'))
		.sort();

	it('has no Electron importer outside the known list', () => {
		expect(importers).toEqual([...KNOWN_ELECTRON_IMPORTERS].sort());
	});

	it('resolves its data directory without Electron', () => {
		for (const file of ['cue-db.ts', 'pipeline-layout-store.ts']) {
			const source = fs.readFileSync(path.join(CUE_DIR, file), 'utf-8');
			expect(source).not.toMatch(/app\.getPath\(/);
			expect(source).toMatch(/resolveUserDataDir/);
		}
	});
});
