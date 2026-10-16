// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/agents/claude-usage-sampler.test.ts
//   - src/__tests__/main/agents/omp-model-catalog.test.ts

import {
	FAILURE_REREPORT_INTERVAL_MS,
	USAGE_PROBE_DIR_NAME,
	ensureUsageProbeDir,
	resetFailureReportingForTests,
	sampleUsage,
} from '../../../main/agents/claude-usage-sampler';
import {
	__resetOmpModelCatalogForTests,
	buildOmpPrimeEnv,
	computeOmpCatalogKey,
	getOmpModelContextWindow,
	primeOmpModelCatalog,
	setOmpModelCatalog,
} from '../../../main/agents/omp-model-catalog';
import type { OmpCatalogEntry } from '../../../main/agents/omp-model-catalog';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import { asarNodePath, canonKey } from '../../helpers/pathExpect';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import * as path_1 from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, captureMessageMock, readAccountIdentityMock, getSnapshotMock } = vi.hoisted(
	() => ({
		mockExecFile: vi.fn(),
		captureMessageMock: vi.fn(),
		readAccountIdentityMock: vi.fn(),
		getSnapshotMock: vi.fn(),
	})
);
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: { ...actual, execFile: mockExecFile },
		execFile: mockExecFile,
	};
});
vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	const wrap = (fn: unknown) => {
		if (fn === mockExecFile) {
			return (...args: unknown[]) =>
				new Promise((resolve, reject) => {
					mockExecFile(...args, (err: Error | null, stdout: string, stderr: string) => {
						if (err) reject(err);
						else resolve({ stdout, stderr });
					});
				});
		}
		return actual.promisify(fn as never);
	};
	return {
		...actual,
		default: { ...actual, promisify: wrap },
		promisify: wrap,
	};
});
vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const homedir = () => '/Users/test';
	return {
		...actual,
		homedir,
		default: { ...actual, homedir },
	};
});
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));
vi.mock('../../../main/agents/claude-account-identity', () => ({
	readClaudeAccountIdentity: readAccountIdentityMock,
}));
vi.mock('../../../main/stores/claudeUsageStore', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/stores/claudeUsageStore')>();
	return { ...actual, getSnapshot: getSnapshotMock };
});
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// ===== from src/__tests__/main/agents/claude-usage-sampler.test.ts =====

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

const ORIGINAL_ENV = { ...process.env };

interface ExecFileCallSite {
	cmd: string;
	args: string[];
	options: Record<string, unknown>;
}

// Helper that primes the mocked execFile binding to invoke its callback with
// the given stdout/stderr (success path). Returns the captured call shape so
// tests can assert on the args/options passed to the spawn.
function primeSuccess(stdout: string, stderr: string = ''): () => ExecFileCallSite | null {
	let captured: ExecFileCallSite | null = null;
	mockExecFile.mockImplementation(
		(cmd: string, args: string[], options: Record<string, unknown>, callback: unknown) => {
			captured = { cmd, args, options };
			if (typeof callback === 'function') {
				(callback as (e: Error | null, o: string, x: string) => void)(null, stdout, stderr);
			}
			return {} as never;
		}
	);
	return () => captured;
}

function primeFailure(err: Error & { code?: string | number; killed?: boolean }): void {
	mockExecFile.mockImplementation(
		(_cmd: string, _args: string[], _options: Record<string, unknown>, callback: unknown) => {
			if (typeof callback === 'function') {
				(callback as (e: Error | null) => void)(err);
			}
			return {} as never;
		}
	);
}

function wireEnvelope(overrides: Record<string, unknown> = {}): string {
	const base = {
		type: 'status',
		config_dir: '/Users/test/.claude',
		session: { percent: 42, resets_at: '2026-05-15T17:00:00.000Z' },
		week_all_models: { percent: 73, resets_at: '2026-05-22T12:00:00.000Z' },
		week_sonnet_only: { percent: 19, resets_at: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
	return `${JSON.stringify(base)}\n`;
}

describe('claude-usage-sampler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		mockExecFile.mockReset();
		captureMessageMock.mockReset();
		captureMessageMock.mockResolvedValue(undefined);
		// The failure memo behind MAESTRO-Q2 is module-level process state, so it
		// outlives a single case. Without this, the second test to hit the same
		// (configDir, stage, reason) would see its report suppressed.
		resetFailureReportingForTests();
		// Default: no identity available, which is the shape every pre-existing
		// assertion in this file was written against.
		readAccountIdentityMock.mockReset();
		readAccountIdentityMock.mockResolvedValue(null);
		getSnapshotMock.mockReset();
		getSnapshotMock.mockReturnValue(null);
		// Restore env to a known baseline; some tests intentionally drop
		// CLAUDE_CONFIG_DIR from `process.env` to verify the ~/.claude fallback.
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			process.env[key] = value;
		}
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('unread secondary weekly window', () => {
		// The parser flags `week_sonnet_only.unread` when a mid-repaint capture
		// clobbered that section. Its 0% is a placeholder, not a measurement.
		const unreadEnvelope = () =>
			wireEnvelope({
				week_sonnet_only: { percent: 0, resets_at: '2026-05-22T12:00:00.000Z', unread: true },
			});
		const cachedWith = (weekSonnetOnly: Record<string, unknown>) => ({
			sampledAt: '2026-05-15T11:00:00.000Z',
			configDirKey: path.resolve('/Users/test/.claude'),
			session: { percent: 40 },
			weekAllModels: { percent: 70, resetsAt: '2026-05-22T12:00:00.000Z' },
			weekSonnetOnly,
		});

		it('keeps the last real reading while its weekly window is still open', async () => {
			getSnapshotMock.mockReturnValue(
				cachedWith({ percent: 18, resetsAt: '2026-05-22T12:00:00.000Z', label: 'Fable' })
			);
			primeSuccess(unreadEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(getSnapshotMock).toHaveBeenCalledWith(path.resolve('/Users/test/.claude'));
			expect(snap?.weekSonnetOnly).toEqual({
				percent: 18,
				resetsAt: '2026-05-22T12:00:00.000Z',
				label: 'Fable',
			});
		});

		it('keeps the placeholder when the last reading belongs to a window that already reset', async () => {
			getSnapshotMock.mockReturnValue(
				cachedWith({ percent: 95, resetsAt: '2026-05-15T06:00:00.000Z', label: 'Fable' })
			);
			primeSuccess(unreadEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap?.weekSonnetOnly).toEqual({ percent: 0, resetsAt: '2026-05-22T12:00:00.000Z' });
		});

		it('keeps the placeholder when nothing is cached for the account', async () => {
			primeSuccess(unreadEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap?.weekSonnetOnly).toEqual({ percent: 0, resetsAt: '2026-05-22T12:00:00.000Z' });
		});

		it('keeps the placeholder when the cache read throws', async () => {
			getSnapshotMock.mockImplementation(() => {
				throw new Error('store unreadable');
			});
			primeSuccess(unreadEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap?.weekSonnetOnly).toEqual({ percent: 0, resetsAt: '2026-05-22T12:00:00.000Z' });
		});

		it('never consults the cache for a window it did read', async () => {
			primeSuccess(wireEnvelope());

			await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(getSnapshotMock).not.toHaveBeenCalled();
		});
	});

	describe('account identity', () => {
		it('stamps the account email / uuid / org onto the snapshot', async () => {
			// The quota is bucketed per Anthropic ACCOUNT, but the snapshot is
			// keyed by config DIRECTORY. Without these fields the dashboard can
			// only label a row by its directory name, and two dirs sharing one
			// login look like a sampling bug.
			readAccountIdentityMock.mockResolvedValue({
				email: 'pedram@smashlabs.com',
				accountUuid: '2acf84ae-d765-4a12-ae90-296b9f903018',
				organizationName: "pedram@smashlabs.com's Organization",
			});
			primeSuccess(wireEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap?.accountEmail).toBe('pedram@smashlabs.com');
			expect(snap?.accountUuid).toBe('2acf84ae-d765-4a12-ae90-296b9f903018');
			expect(snap?.organizationName).toBe("pedram@smashlabs.com's Organization");
		});

		it('reads the identity from the canonical config dir, not the wire echo', async () => {
			// `config_dir` in the wire is whatever string maestro-p printed;
			// the snapshot key is the locally-resolved path. Reading the
			// identity from anything but the key would let the two disagree.
			readAccountIdentityMock.mockResolvedValue(null);
			primeSuccess(wireEnvelope({ config_dir: '/some/echoed/path/' }));

			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				configDir: '/Users/test/.claude-smash',
			});

			// The identity is read with the RESOLVED key, so the expectation has to go
			// through the same primitive - a bare POSIX literal fails on Windows, where
			// `path.resolve` drive-anchors it. Every sibling assertion already does this.
			expect(readAccountIdentityMock).toHaveBeenCalledWith(canonKey('/Users/test/.claude-smash'));
		});

		it('omits the identity fields entirely when the account is unknown', async () => {
			// Absent rather than `undefined`-valued, so a snapshot from a dir
			// that was never logged into persists in the same shape it always
			// did and older cached snapshots stay comparable.
			readAccountIdentityMock.mockResolvedValue(null);
			primeSuccess(wireEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap).not.toHaveProperty('accountEmail');
			expect(snap).not.toHaveProperty('accountUuid');
			expect(snap).not.toHaveProperty('organizationName');
		});

		it('keeps the fields it does know when the identity is partial', async () => {
			readAccountIdentityMock.mockResolvedValue({ email: 'legacy@example.com' });
			primeSuccess(wireEnvelope());

			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });

			expect(snap?.accountEmail).toBe('legacy@example.com');
			expect(snap).not.toHaveProperty('accountUuid');
		});
	});

	describe('happy path', () => {
		it('returns a snapshot with the wire fields mapped to camelCase', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/opt/maestro/resources/maestro-p.js',
			});
			expect(snap).toEqual({
				sampledAt: new Date(FROZEN_NOW).toISOString(),
				configDirKey: canonKey(path.join(os.homedir(), '.claude')),
				authState: 'authenticated',
				session: { percent: 42, resetsAt: '2026-05-15T17:00:00.000Z' },
				weekAllModels: { percent: 73, resetsAt: '2026-05-22T12:00:00.000Z' },
				weekSonnetOnly: { percent: 19, resetsAt: '2026-05-22T12:00:00.000Z' },
			});
		});

		it('sets sampledAt on the sampling host, not from the wire', async () => {
			// Wire envelope's `sampled_at` (if any) is intentionally ignored;
			// even an unrelated `sampled_at` value in the wire shouldn't leak
			// into the snapshot's sampledAt. We assert against the local clock.
			primeSuccess(wireEnvelope());
			const localIso = new Date(FROZEN_NOW).toISOString();
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
			});
			expect(snap?.sampledAt).toBe(localIso);
		});

		it('spawns process.execPath with [binPath, --status]', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/opt/maestro/maestro-p.js' });
			const call = inspect();
			expect(call?.cmd).toBe(process.execPath);
			expect(call?.args).toEqual(['/opt/maestro/maestro-p.js', '--status']);
		});

		it('starts claude in the private usage probe folder and opts into trusting it', async () => {
			// Not the caller's folder: an agent's project would load its hooks and
			// MCP servers on every probe, and the home dir's trust prompt says "No".
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			const options = inspect()?.options as { cwd: string; env: Record<string, string> };
			expect(options.cwd).toBe(path.join(os.tmpdir(), USAGE_PROBE_DIR_NAME));
			expect(options.env.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe('1');
		});

		it('uses the default 30s timeout when none is provided', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(inspect()?.options.timeout).toBe(30_000);
		});

		it('honors a custom timeoutMs', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', timeoutMs: 5_000 });
			expect(inspect()?.options.timeout).toBe(5_000);
		});

		it('caps maxBuffer at 1MB', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(inspect()?.options.maxBuffer).toBe(1 * 1024 * 1024);
		});
	});

	describe('env composition', () => {
		it('layers customEnvVars over process.env', async () => {
			process.env.PATH = '/usr/bin';
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				customEnvVars: { MAESTRO_CLAUDE_BIN: '/opt/claude' },
			});
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.PATH).toBe('/usr/bin');
			expect(env.MAESTRO_CLAUDE_BIN).toBe('/opt/claude');
		});

		it('forces BROWSER to a no-op so an expired-token account can never pop the OAuth browser', async () => {
			// A read-only `/usage` probe must stay OAuth-silent: claude's URL opener
			// uses $BROWSER as the launch command and does not fall back to the
			// system opener, so a no-op here makes the consent flow open nothing on
			// an unattended background refresh tick. Regressing this silently
			// re-pops authorization windows.
			process.env.BROWSER = '/usr/bin/open-a-real-browser';
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.BROWSER).toBe('/usr/bin/true');
		});

		it('sets ELECTRON_RUN_AS_NODE=1 so the Electron execPath runs maestro-p as Node', async () => {
			// Without this, a packaged app would spawn a second GUI instance
			// instead of executing the maestro-p script, and --status would
			// never produce a snapshot.
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
		});

		it('prepends the in-asar node_modules to NODE_PATH when packaged (resourcesPath set)', async () => {
			// Must be the in-asar path, NOT app.asar.unpacked: node-pty rewrites
			// `app.asar` -> `app.asar.unpacked` once to find its spawn-helper, so
			// handing it the already-unpacked path double-applies the replace and
			// the helper exec fails with "posix_spawn failed: No such file or
			// directory" (silently broke every packaged Claude usage sample).
			const originalResourcesPath = process.resourcesPath;
			Object.defineProperty(process, 'resourcesPath', {
				value: '/Apps/Maestro.app/Contents/Resources',
				configurable: true,
			});
			process.env.NODE_PATH = '/pre/existing';
			try {
				const inspect = primeSuccess(wireEnvelope());
				await sampleUsage({ binPath: '/bin/maestro-p.js' });
				const env = inspect()?.options.env as NodeJS.ProcessEnv;
				const asar = asarNodePath('/Apps/Maestro.app/Contents/Resources');
				expect(env.NODE_PATH).toBe(`${asar}${path.delimiter}/pre/existing`);
			} finally {
				Object.defineProperty(process, 'resourcesPath', {
					value: originalResourcesPath,
					configurable: true,
				});
			}
		});

		it('leaves NODE_PATH untouched in dev (no resourcesPath)', async () => {
			const originalResourcesPath = process.resourcesPath;
			Object.defineProperty(process, 'resourcesPath', {
				value: '',
				configurable: true,
			});
			delete process.env.NODE_PATH;
			try {
				const inspect = primeSuccess(wireEnvelope());
				await sampleUsage({ binPath: '/bin/maestro-p.js' });
				const env = inspect()?.options.env as NodeJS.ProcessEnv;
				expect(env.NODE_PATH).toBeUndefined();
			} finally {
				Object.defineProperty(process, 'resourcesPath', {
					value: originalResourcesPath,
					configurable: true,
				});
			}
		});

		it('lets explicit configDir win over customEnvVars.CLAUDE_CONFIG_DIR', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				configDir: '/Users/test/.claude-explicit',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-smuggled' },
			});
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-explicit');
		});

		it('keys the snapshot by resolved configDir, not the wire echo', async () => {
			// Wire echoes a different path than what the wrapper actually used;
			// the snapshot must follow the wrapper's resolved env, not the
			// wire's echo. This protects against path-form drift across hosts.
			primeSuccess(wireEnvelope({ config_dir: '/echoed/by/binary/that/we/ignore' }));
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				configDir: '/Users/test/.claude-gmail',
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-gmail'));
		});

		it('canonicalizes a configDir with redundant separators in the key', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				configDir: '/Users/test/./.claude-smash/',
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-smash'));
		});

		it('falls back to ~/.claude when no configDir and no env var', async () => {
			delete process.env.CLAUDE_CONFIG_DIR;
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap?.configDirKey).toBe(canonKey(path.join(os.homedir(), '.claude')));
		});

		it('lets customEnvVars.CLAUDE_CONFIG_DIR drive the key when configDir is omitted', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-via-env' },
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-via-env'));
		});
	});

	describe('tolerance', () => {
		it('tolerates a leading node deprecation warning on stdout', async () => {
			const noisy =
				'(node:1234) DeprecationWarning: Buffer() is deprecated\n' +
				'(Use `node --trace-deprecation ...` to show where the warning was created)\n' +
				wireEnvelope();
			primeSuccess(noisy);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap?.session.percent).toBe(42);
		});

		it('tolerates whitespace before the JSON line', async () => {
			primeSuccess(`   ${wireEnvelope()}`);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).not.toBeNull();
		});

		it('ignores stderr content entirely (only stdout drives parsing)', async () => {
			primeSuccess(wireEnvelope(), 'some random stderr output');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).not.toBeNull();
		});
	});

	describe('failure modes - never throw, always return null', () => {
		it('returns null on ENOENT (binary missing)', async () => {
			primeFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
			const snap = await sampleUsage({ binPath: '/nope.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'ENOENT' })
			);
		});

		it('returns null on EACCES', async () => {
			primeFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
			const snap = await sampleUsage({ binPath: '/locked.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'EACCES' })
			);
		});

		it('returns null on timeout (killed=true, no code)', async () => {
			const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
			primeFailure(err);
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				timeoutMs: 1_000,
			});
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'timeout' })
			);
		});

		it('returns null on non-zero exit (code is a number)', async () => {
			primeFailure(Object.assign(new Error('exit 2'), { code: 2 }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: expect.stringContaining('exit') })
			);
		});

		it('returns null on empty stdout', async () => {
			primeSuccess('');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse', reason: 'empty stdout' })
			);
		});

		it('returns null when stdout has only non-JSON noise', async () => {
			primeSuccess('this is not json\nneither is this\n');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse' })
			);
		});

		it('returns null on malformed JSON', async () => {
			primeSuccess('{ not really json }\n');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse', reason: expect.stringMatching(/json parse/) })
			);
		});

		it('returns null when type is not status', async () => {
			primeSuccess(wireEnvelope({ type: 'something-else' }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
		});

		it('returns null when session window is missing', async () => {
			primeSuccess(wireEnvelope({ session: undefined }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
		});

		it('returns null when a percent field is a string', async () => {
			primeSuccess(
				wireEnvelope({
					session: { percent: '42' as unknown as number, resets_at: '2026-05-15T17:00:00.000Z' },
				})
			);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
		});

		// A missing resets_at is a legitimate wire shape, not a malformed one:
		// claude paints no "Resets ..." row for a window with nothing running in
		// it, and rejecting the envelope over that used to throw away the
		// percentages of an exhausted account - the one case the dashboard most
		// needs to show.
		it('keeps the snapshot when a resets_at field is missing, dropping only that field', async () => {
			primeSuccess(wireEnvelope({ week_all_models: { percent: 50 } }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap?.weekAllModels).toEqual({ percent: 50 });
			expect(snap?.session.resetsAt).toBeTruthy();
		});

		it('returns null when a resets_at field is present but not a string', async () => {
			primeSuccess(
				wireEnvelope({
					week_all_models: { percent: 50, resets_at: 12345 as unknown as string },
				})
			);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap).toBeNull();
		});

		it('carries the second weekly window label through to the snapshot', async () => {
			primeSuccess(
				wireEnvelope({
					week_sonnet_only: {
						percent: 36,
						resets_at: '2026-05-15T17:00:00.000Z',
						label: 'Fable',
					},
				})
			);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js' });
			expect(snap?.weekSonnetOnly.label).toBe('Fable');
		});
	});

	describe('repeat-failure suppression (MAESTRO-Q2)', () => {
		const OPTS = { binPath: '/bin/maestro-p.js', configDir: '/home/u/.claude' };

		it('reports the first failure but not identical repeats', async () => {
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));

			for (let i = 0; i < 5; i++) {
				expect(await sampleUsage(OPTS)).toBeNull();
			}

			// Every tick still returns null and still logs; only the report is deduped.
			expect(captureMessageMock).toHaveBeenCalledTimes(1);
			expect(captureMessageMock.mock.calls[0][2]).toMatchObject({
				stage: 'spawn',
				reason: 'exit: 1',
			});
		});

		it('reports again when the failure signature changes', async () => {
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));
			await sampleUsage(OPTS);
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(1);

			// Same config dir, different reason - this is new information.
			primeFailure(Object.assign(new Error('nope'), { code: 'ENOENT' }));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(2);
			expect(captureMessageMock.mock.calls[1][2]).toMatchObject({ reason: 'ENOENT' });
		});

		it('keeps config dirs independent so one broken account cannot mute another', async () => {
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));

			await sampleUsage({ ...OPTS, configDir: '/home/u/.claude-a' });
			await sampleUsage({ ...OPTS, configDir: '/home/u/.claude-a' });
			await sampleUsage({ ...OPTS, configDir: '/home/u/.claude-b' });

			expect(captureMessageMock).toHaveBeenCalledTimes(2);
			expect(
				captureMessageMock.mock.calls.map((c) => (c[2] as { configDir: string }).configDir)
			).toEqual([canonKey('/home/u/.claude-a'), canonKey('/home/u/.claude-b')]);
		});

		it('keys off customEnvVars.CLAUDE_CONFIG_DIR too, not just opts.configDir', async () => {
			// `CLAUDE_CONFIG_DIR` can arrive through customEnvVars instead of the
			// explicit option, and the sampler honors it for the snapshot key. A memo
			// keyed on opts.configDir alone would collapse both of these onto
			// ~/.claude: the first account would mute the second, and both
			// breadcrumbs would name the wrong directory.
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));

			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/home/u/.claude-env-a' },
			});
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/home/u/.claude-env-b' },
			});

			expect(captureMessageMock).toHaveBeenCalledTimes(2);
			expect(
				captureMessageMock.mock.calls.map((c) => (c[2] as { configDir: string }).configDir)
			).toEqual([canonKey('/home/u/.claude-env-a'), canonKey('/home/u/.claude-env-b')]);
		});

		it('re-reports an unchanged failure once the interval elapses', async () => {
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(1);

			vi.setSystemTime(new Date(FROZEN_NOW + FAILURE_REREPORT_INTERVAL_MS - 1));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(1);

			vi.setSystemTime(new Date(FROZEN_NOW + FAILURE_REREPORT_INTERVAL_MS));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(2);
		});

		it('forgets the history after a success so a flapping account reports again', async () => {
			primeFailure(Object.assign(new Error('boom'), { code: 1 }));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(1);

			primeSuccess(wireEnvelope());
			expect(await sampleUsage(OPTS)).not.toBeNull();

			primeFailure(Object.assign(new Error('boom'), { code: 1 }));
			await sampleUsage(OPTS);
			expect(captureMessageMock).toHaveBeenCalledTimes(2);
		});
	});

	describe('Sentry payload safety', () => {
		it('does not include the full env or full stdout in the Sentry breadcrumb', async () => {
			primeSuccess('totally not json that mentions secret_token=abc123\n');
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				customEnvVars: { SECRET: 'should-not-leak' },
			});
			expect(captureMessageMock).toHaveBeenCalledTimes(1);
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			expect(Object.keys(extras).sort()).toEqual(['binPath', 'configDir', 'reason', 'stage']);
			// And no field carries any whiff of the stdout body or env values.
			for (const value of Object.values(extras)) {
				expect(String(value)).not.toContain('secret_token');
				expect(String(value)).not.toContain('should-not-leak');
			}
		});

		it('uses the explicit configDir in the breadcrumb when provided', async () => {
			primeSuccess('garbage\n');
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				configDir: '/Users/test/.claude-explicit',
			});
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			// Resolved, like the snapshot key it now mirrors - a bare POSIX literal
			// fails on Windows where `path.resolve` drive-anchors it.
			expect(extras.configDir).toBe(canonKey('/Users/test/.claude-explicit'));
		});

		it('falls back to ~/.claude in the breadcrumb when configDir is omitted', async () => {
			primeSuccess('garbage\n');
			await sampleUsage({ binPath: '/bin/maestro-p.js' });
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			expect(extras.configDir).toBe(canonKey(path.join(os.homedir(), '.claude')));
		});
	});
});

describe('ensureUsageProbeDir', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'usage-probe-test-'));
	});

	afterEach(async () => {
		await fs.promises.rm(base, { recursive: true, force: true });
	});

	it('creates the probe folder and returns it, reusing it on later calls', async () => {
		const dir = await ensureUsageProbeDir(base);
		expect(dir).toBe(path.join(base, USAGE_PROBE_DIR_NAME));
		expect((await fs.promises.lstat(dir as string)).isDirectory()).toBe(true);
		expect(await ensureUsageProbeDir(base)).toBe(dir);
	});

	it.skipIf(process.platform === 'win32')('creates it private to this user', async () => {
		const dir = await ensureUsageProbeDir(base);
		expect((await fs.promises.stat(dir as string)).mode & 0o077).toBe(0);
	});

	it.skipIf(process.platform === 'win32')(
		'refuses a symlink planted at the probe path',
		async () => {
			// Trusting it would trust wherever the link points.
			const target = await fs.promises.mkdtemp(path.join(base, 'elsewhere-'));
			await fs.promises.symlink(target, path.join(base, USAGE_PROBE_DIR_NAME));
			expect(await ensureUsageProbeDir(base)).toBeNull();
		}
	);

	it.skipIf(process.platform === 'win32')('refuses a folder other users can write to', async () => {
		// Another user could plant a .claude/settings.json hook in it before we trust it.
		const dir = path.join(base, USAGE_PROBE_DIR_NAME);
		await fs.promises.mkdir(dir);
		await fs.promises.chmod(dir, 0o777);
		expect(await ensureUsageProbeDir(base)).toBeNull();
	});
});

// ===== from src/__tests__/main/agents/omp-model-catalog.test.ts =====

// Mirrors the shape `omp models --json` returns for a couple of models.
const SAMPLE: OmpCatalogEntry[] = [
	{ id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 },
	{ id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', contextWindow: 200_000 },
];

// A single fixed identity for the common-case tests.
const KEY = computeOmpCatalogKey('/usr/local/bin/omp', undefined);

describe('omp-model-catalog', () => {
	beforeEach(() => {
		__resetOmpModelCatalogForTests();
	});

	it('returns null before the catalog is primed', () => {
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBeNull();
	});

	it('resolves the real window by bare model id (what the stream reports)', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
		expect(getOmpModelContextWindow('claude-haiku-4-5', KEY)).toBe(200_000);
	});

	it('resolves by the provider-qualified selector too', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('anthropic/claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	it('resolves a bare id even when only the selector was reported for the turn', () => {
		setOmpModelCatalog([{ selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 }], KEY);
		// The stream may report the bare id; the selector entry still resolves it.
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	it('is case-insensitive', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('Claude-Opus-4-8', KEY)).toBe(1_000_000);
	});

	it('returns null for an unknown or empty model', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('gpt-6-imaginary', KEY)).toBeNull();
		expect(getOmpModelContextWindow('', KEY)).toBeNull();
		expect(getOmpModelContextWindow(undefined, KEY)).toBeNull();
	});

	it('ignores entries without a positive contextWindow', () => {
		setOmpModelCatalog([{ id: 'no-window' }, { id: 'zero-window', contextWindow: 0 }], KEY);
		expect(getOmpModelContextWindow('no-window', KEY)).toBeNull();
		expect(getOmpModelContextWindow('zero-window', KEY)).toBeNull();
	});

	it('does not serve one identity\u2019s catalog to another', () => {
		const keyA = computeOmpCatalogKey('/opt/omp-a/omp', undefined);
		const keyB = computeOmpCatalogKey('/opt/omp-b/omp', undefined);
		// Same bare model id, DIFFERENT windows across two local installs.
		setOmpModelCatalog([{ id: 'custom-model', contextWindow: 500_000 }], keyA);
		setOmpModelCatalog([{ id: 'custom-model', contextWindow: 128_000 }], keyB);
		expect(getOmpModelContextWindow('custom-model', keyA)).toBe(500_000);
		expect(getOmpModelContextWindow('custom-model', keyB)).toBe(128_000);
		// An unprimed identity resolves nothing.
		const keyC = computeOmpCatalogKey('/opt/omp-c/omp', undefined);
		expect(getOmpModelContextWindow('custom-model', keyC)).toBeNull();
	});

	it('env overrides produce distinct identities', () => {
		const base = computeOmpCatalogKey('/usr/local/bin/omp', undefined);
		const withEnv = computeOmpCatalogKey('/usr/local/bin/omp', { PI_MODEL: 'x' });
		expect(base).not.toBe(withEnv);
		// Order-independent: same overrides hash equal regardless of insertion order.
		const a = computeOmpCatalogKey('/usr/local/bin/omp', { A: '1', B: '2' });
		const b = computeOmpCatalogKey('/usr/local/bin/omp', { B: '2', A: '1' });
		expect(a).toBe(b);
	});

	it('does not resolve a bare id that collides on differing windows within an identity', () => {
		// Two providers expose the same bare `gpt-5` id at different windows.
		setOmpModelCatalog(
			[
				{ id: 'gpt-5', selector: 'openai/gpt-5', contextWindow: 400_000 },
				{ id: 'gpt-5', selector: 'proxy/gpt-5', contextWindow: 128_000 },
			],
			KEY
		);
		// Ambiguous bare/id -> no authoritative window.
		expect(getOmpModelContextWindow('gpt-5', KEY)).toBeNull();
		// The unambiguous provider-qualified selectors still resolve exactly.
		expect(getOmpModelContextWindow('openai/gpt-5', KEY)).toBe(400_000);
		expect(getOmpModelContextWindow('proxy/gpt-5', KEY)).toBe(128_000);
	});

	it('replaces (not merges) an identity\u2019s catalog on re-prime', () => {
		setOmpModelCatalog([{ id: 'gone-model', contextWindow: 300_000 }], KEY);
		expect(getOmpModelContextWindow('gone-model', KEY)).toBe(300_000);
		// A fresh snapshot no longer lists that model.
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('gone-model', KEY)).toBeNull();
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	describe('buildOmpPrimeEnv', () => {
		it('drops empty PATH components when prepending the binary dir', () => {
			// A PATH with a trailing/interior delimiter yields empty components after
			// split; on POSIX an empty entry means "search the CWD", so the prime
			// probe must never carry one.
			const env = buildOmpPrimeEnv('/opt/tester/.bun/bin/omp', {
				PATH: ['/usr/local/bin', '', '/usr/bin', ''].join(path_1.delimiter),
			});
			const entries = (env.PATH ?? '').split(path_1.delimiter);
			expect(entries).not.toContain('');
			// The binary's own dir leads so a co-located runtime resolves first.
			expect(entries[0]).toBe(path_1.dirname('/opt/tester/.bun/bin/omp'));
			expect(entries).toContain('/usr/local/bin');
			expect(entries).toContain('/usr/bin');
		});
	});

	describe('primeOmpModelCatalog negative caching', () => {
		// The PATH a failing prime ran with is the whole point of the diagnostics:
		// in a packaged app it distinguishes "omp is broken" from "the packaged
		// PATH lost ~/.bun/bin".
		const PRIME_ENV = { PATH: ['/opt/x', '/usr/bin'].join(path_1.delimiter) };

		beforeEach(() => {
			vi.mocked(execFileNoThrow).mockReset();
			vi.mocked(logger.warn).mockClear();
		});

		it('negative-caches a valid JSON payload without a models array', async () => {
			const key = computeOmpCatalogKey('/opt/x/omp', undefined);
			// Command runs and exits 0, but the payload has no `models` array - it is
			// unusable, so it must be treated like a failure for the TTL.
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '{"notModels":[]}',
				stderr: '',
				exitCode: 0,
			});
			await primeOmpModelCatalog('/opt/x/omp', PRIME_ENV, key);
			// A second prime within the TTL is short-circuited by the failure cache
			// rather than re-running the same bad command.
			await primeOmpModelCatalog('/opt/x/omp', PRIME_ENV, key);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			// Nothing was cataloged for that identity.
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBeNull();
			// The unusable-payload warn carries the same diagnostics as an outright
			// failure (it previously carried no structured fields at all).
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('no models array'),
				expect.any(String),
				expect.objectContaining({
					command: '/opt/x/omp',
					path: PRIME_ENV.PATH,
					elapsedMs: expect.any(Number),
				})
			);
		});

		it('logs the command, PATH and elapsed time when the prime exits non-zero', async () => {
			const key = computeOmpCatalogKey('/opt/fail/omp', undefined);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '  bun: command not found  ',
				exitCode: 127,
			});
			await primeOmpModelCatalog('/opt/fail/omp', PRIME_ENV, key);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('failed'),
				expect.any(String),
				expect.objectContaining({
					command: '/opt/fail/omp',
					path: PRIME_ENV.PATH,
					elapsedMs: expect.any(Number),
					exitCode: 127,
					stderr: 'bun: command not found',
				})
			);
		});

		it('logs the command, PATH and elapsed time when the prime throws', async () => {
			const key = computeOmpCatalogKey('/opt/throw/omp', undefined);
			vi.mocked(execFileNoThrow).mockRejectedValue(new Error('spawn ENOENT'));
			await primeOmpModelCatalog('/opt/throw/omp', PRIME_ENV, key);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({
					command: '/opt/throw/omp',
					path: PRIME_ENV.PATH,
					elapsedMs: expect.any(Number),
					error: expect.stringContaining('spawn ENOENT'),
				})
			);
		});

		it('retryFailedPrime re-runs a prime the failure cache would have suppressed', async () => {
			const key = computeOmpCatalogKey('/opt/retry/omp', undefined);
			// First attempt fails (e.g. a cold packaged start) and is negative-cached.
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'boom',
				exitCode: 1,
			});
			await primeOmpModelCatalog('/opt/retry/omp', PRIME_ENV, key);
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBeNull();

			// Without the option, the negative cache still suppresses the re-prime.
			await primeOmpModelCatalog('/opt/retry/omp', PRIME_ENV, key);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);

			// A spawn opts out, gets a fresh attempt, and the catalog resolves - so a
			// single early failure can't pin the 200k fallback for the whole TTL.
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: JSON.stringify({ models: SAMPLE }),
				stderr: '',
				exitCode: 0,
			});
			await primeOmpModelCatalog('/opt/retry/omp', PRIME_ENV, key, { retryFailedPrime: true });
			expect(execFileNoThrow).toHaveBeenCalledTimes(2);
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBe(1_000_000);
		});

		it('retryFailedPrime still shares an in-flight prime and honors a fresh catalog', async () => {
			const key = computeOmpCatalogKey('/opt/inflight/omp', undefined);
			let release: (() => void) | undefined;
			vi.mocked(execFileNoThrow).mockReturnValue(
				new Promise((resolve) => {
					release = () =>
						resolve({ stdout: JSON.stringify({ models: SAMPLE }), stderr: '', exitCode: 0 });
				})
			);

			// Concurrent spawns share the one fetch even with the option set.
			const first = primeOmpModelCatalog('/opt/inflight/omp', PRIME_ENV, key, {
				retryFailedPrime: true,
			});
			const second = primeOmpModelCatalog('/opt/inflight/omp', PRIME_ENV, key, {
				retryFailedPrime: true,
			});
			expect(second).toBe(first);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			release?.();
			await Promise.all([first, second]);
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBe(1_000_000);

			// And a fresh catalog is still not re-fetched, option or not.
			await primeOmpModelCatalog('/opt/inflight/omp', PRIME_ENV, key, { retryFailedPrime: true });
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		});

		it('re-primes and caches once a valid models array arrives', async () => {
			const key = computeOmpCatalogKey('/opt/y/omp', undefined);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: JSON.stringify({ models: SAMPLE }),
				stderr: '',
				exitCode: 0,
			});
			await primeOmpModelCatalog('/opt/y/omp', {}, key);
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBe(1_000_000);
			// Cached: a second call within the TTL doesn't re-run the command.
			await primeOmpModelCatalog('/opt/y/omp', {}, key);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		});
	});
});
