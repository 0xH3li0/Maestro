// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/coworking/coworking-audit.test.ts
//   - src/__tests__/main/coworking/coworking-bridge.test.ts
//   - src/__tests__/main/coworking/coworking-registry.test.ts
//   - src/__tests__/main/coworking/coworking-session-id.test.ts
//   - src/__tests__/main/coworking/coworking-types.test.ts
//   - src/__tests__/main/coworking/pid-resolution-windows.test.ts
//   - src/__tests__/main/coworking/pid-resolution.test.ts

import { redactBrowserOpDetail } from '../../../main/coworking/coworking-audit';
import { __testing } from '../../../main/coworking/coworking-bridge';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import { resolveOwningMaestroSessionId } from '../../../main/coworking/coworking-session-id';
import * as tools from '../../../main/coworking/coworking-tools';
import {
	COWORKING_MCP_SERVER_NAME,
	COWORKING_SOCKET_ENV_VAR,
	formatCoworkingId,
	parseCoworkingId,
} from '../../../main/coworking/coworking-types';
import {
	MAX_PID_WALK_HOPS,
	resolveSessionFromPidWalk,
} from '../../../main/coworking/pid-resolution';
import type { getParentPid } from '../../../main/coworking/pid-resolution';
import type { Socket } from 'net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/coworking-test-userdata' },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-tools', () => {
	return {
		listTerminals: vi.fn((sessionId: string) => ({
			terminals: [{ id: 'term:1', cwd: '/x', title: `for ${sessionId}` }],
		})),
		readTerminal: vi.fn(async (sessionId: string, args: { id: string }) => ({
			id: args.id,
			content: `body for ${sessionId}/${args.id}`,
			truncated: false,
			totalLines: 1,
		})),
	};
});
const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));
vi.mock('child_process', () => {
	const execFile = () => {
		throw new Error('coworking pid-resolution must use the promisified execFile');
	};
	// promisify(execFile) returns this custom form; util.promisify.custom is the
	// globally-registered Symbol.for('nodejs.util.promisify.custom').
	(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
		async (file: string, args: string[], options: unknown) => execFileImpl(file, args, options);
	return { execFile, default: { execFile } };
});
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => true),
	isMacOS: vi.fn(() => false),
	isLinux: vi.fn(() => false),
}));

// ===== from src/__tests__/main/coworking/coworking-audit.test.ts =====

describe('redactBrowserOpDetail', () => {
	it('strips navigate URLs to origin+path with query/hash character counts', () => {
		const detail = redactBrowserOpDetail({
			kind: 'navigate',
			url: 'https://app.example.com/login?token=SECRET123#access=SECRET456',
		});
		// '?token=SECRET123' -> 15 query chars; '#access=SECRET456' -> 16 hash chars.
		expect(detail).toBe('url=https://app.example.com/login queryChars=15 hashChars=16');
		expect(detail).not.toContain('SECRET');
	});

	it('omits query/hash counts when the URL has neither', () => {
		expect(redactBrowserOpDetail({ kind: 'navigate', url: 'https://x.com/docs' })).toBe(
			'url=https://x.com/docs'
		);
	});

	it('reduces non-URL navigate targets to a character count, never verbatim', () => {
		const detail = redactBrowserOpDetail({ kind: 'navigate', url: 'my secret query' });
		expect(detail).toBe('url=<non-url textChars=15>');
		expect(detail).not.toContain('secret');
	});

	it('newTab redacts the URL the same way and appends the ephemeral flag', () => {
		expect(
			redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p?t=abc', ephemeral: true })
		).toBe('url=https://x.com/p queryChars=5 ephemeral');
		expect(redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p' })).toBe(
			'url=https://x.com/p'
		);
		expect(redactBrowserOpDetail({ kind: 'newTab', ephemeral: true })).toBe(
			'url=<default> ephemeral'
		);
		expect(redactBrowserOpDetail({ kind: 'newTab' })).toBe('url=<default>');
	});

	it('waitFor records the selector and timeout only when present', () => {
		expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login', timeoutMs: 5000 })).toBe(
			'selector=#login timeoutMs=5000'
		);
		expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login' })).toBe('selector=#login');
	});

	it('eval and type reduce free-form content to lengths, never verbatim', () => {
		const evalDetail = redactBrowserOpDetail({
			kind: 'eval',
			code: 'document.cookie = "leak"',
		});
		expect(evalDetail).toBe('codeLen=24');
		expect(evalDetail).not.toContain('cookie');
		const typeDetail = redactBrowserOpDetail({
			kind: 'type',
			selector: '#password',
			text: 'hunter2!',
		});
		expect(typeDetail).toBe('selector=#password textLen=8');
		expect(typeDetail).not.toContain('hunter2');
	});
});

// ===== from src/__tests__/main/coworking/coworking-bridge.test.ts =====

function newConn(): Socket {
	// WeakMap keys must be objects; a plain `{}` is sufficient for dispatch().
	return {} as unknown as Socket;
}

describe('coworking-bridge dispatch (handshake + session binding)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
	});

	it('rejects listTerminals before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, { id: 1, method: 'listTerminals' });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.listTerminals).not.toHaveBeenCalled();
	});

	it('rejects readTerminal before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'readTerminal',
			params: { id: 'term:1' },
		});
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.readTerminal).not.toHaveBeenCalled();
	});

	it('hello with sessionId binds the connection', async () => {
		const conn = newConn();
		const state = { sessionId: null as string | null };
		__testing.connections.set(conn, state);

		const helloResp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		expect(helloResp.error).toBeUndefined();
		expect(helloResp.result).toEqual({ ok: true });
		expect(state.sessionId).toBe('sess-A');
	});

	it('hello rejects when neither sessionId nor ppid is provided', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const r1 = await __testing.dispatch(conn, { id: 1, method: 'hello' });
		expect(r1.error?.code).toBe(-32602);

		const r2 = await __testing.dispatch(conn, {
			id: 2,
			method: 'hello',
			params: { sessionId: '' },
		});
		expect(r2.error?.code).toBe(-32602);

		const r3 = await __testing.dispatch(conn, {
			id: 3,
			method: 'hello',
			params: { ppid: 0 },
		});
		expect(r3.error?.code).toBe(-32602);
	});

	it('hello with ppid resolves session via the registered resolver', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async (pid: number) => (pid === 4242 ? 'sess-via-pid' : null));
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(resp.result).toEqual({ ok: true });
		expect(resolver).toHaveBeenCalledWith(4242);
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-via-pid');
	});

	it('hello with ppid rejects when resolver returns null', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(async () => null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 99999 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/peer PID/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with ppid but no resolver wired rejects', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 100 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/resolver not configured/i);
	});

	it('hello with sessionId + a ppid that resolves to the SAME session binds it', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-explicit');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello with sessionId + a ppid the resolver cannot map (null) still trusts sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => null);
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		// A null (can't-determine) result is NOT a mismatch: env-propagating
		// agents whose PIDs aren't tracked must not regress.
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello rejects when the ppid resolves to a DIFFERENT session than the claimed sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-from-pid');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/does not match caller process/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with sessionId and NO resolver wired trusts sessionId (env-only agents)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
	});

	it('after hello, listTerminals is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		const resp = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(resp.error).toBeUndefined();
		expect(tools.listTerminals).toHaveBeenCalledWith('sess-A');
	});

	it('after hello, readTerminal is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readTerminal',
			params: { id: 'term:7' },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.readTerminal).toHaveBeenCalledWith('sess-B', { id: 'term:7', lines: undefined });
	});

	it('two connections with different sessionIds do not bleed (privacy regression)', async () => {
		const connA = newConn();
		const connB = newConn();
		__testing.connections.set(connA, { sessionId: null });
		__testing.connections.set(connB, { sessionId: null });

		await __testing.dispatch(connA, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		await __testing.dispatch(connB, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});

		await __testing.dispatch(connA, { id: 2, method: 'listTerminals' });
		await __testing.dispatch(connB, { id: 2, method: 'listTerminals' });

		expect(tools.listTerminals).toHaveBeenNthCalledWith(1, 'sess-A');
		expect(tools.listTerminals).toHaveBeenNthCalledWith(2, 'sess-B');
	});

	it('readTerminal with missing id returns invalid-params error', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, { id: 2, method: 'readTerminal', params: {} });
		expect(resp.error?.code).toBe(-32602);
	});

	it('unknown method returns -32601 even after hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'wat' as 'hello',
		});
		expect(resp.error?.code).toBe(-32601);
	});
});

// ===== from src/__tests__/main/coworking/coworking-registry.test.ts =====

describe('CoworkingRegistry', () => {
	let registry: CoworkingRegistry;

	beforeEach(() => {
		registry = new CoworkingRegistry();
	});

	function rec(id: string, tabUuid: string, sessionId: string, cwd = '/tmp', title = 'Terminal') {
		return { id, tabUuid, sessionId, cwd, title };
	}

	it('returns an empty list for a session with no records', () => {
		expect(registry.listForSession('sess-1')).toEqual([]);
	});

	it('lists terminals scoped to the requested sessionId only', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
		expect(registry.listForSession('sess-1')).toEqual([
			{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
		]);
		expect(registry.listForSession('sess-2')).toEqual([
			{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
		]);
	});

	it('does NOT leak records across sessions (privacy regression test for PR #948 blocker)', () => {
		// Session A has term:3 only; session B has term:1 only. Asking for either
		// session must never include the other's records, regardless of insertion order.
		registry.upsertTerminal(rec('term:3', 'uuid-a3', 'sess-A', '/a', 'A-Term-3'));
		registry.upsertTerminal(rec('term:1', 'uuid-b1', 'sess-B', '/b', 'B-Term-1'));
		expect(registry.listForSession('sess-A')).toEqual([
			{ id: 'term:3', cwd: '/a', title: 'A-Term-3' },
		]);
		expect(registry.listForSession('sess-B')).toEqual([
			{ id: 'term:1', cwd: '/b', title: 'B-Term-1' },
		]);
		expect(registry.resolveTabUuidForSession('sess-A', 'term:1')).toBeNull();
		expect(registry.resolveTabUuidForSession('sess-B', 'term:3')).toBeNull();
	});

	it('sorts entries by numeric coworkingId', () => {
		registry.upsertTerminal(rec('term:10', 'uuid-c', 'sess-1'));
		registry.upsertTerminal(rec('term:2', 'uuid-d', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual([
			'term:1',
			'term:2',
			'term:10',
		]);
	});

	it('resolveTabUuidForSession resolves only within the requested session', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
		expect(registry.resolveTabUuidForSession('sess-1', 'term:1')).toBe('uuid-a');
		expect(registry.resolveTabUuidForSession('sess-2', 'term:1')).toBe('uuid-b');
		expect(registry.resolveTabUuidForSession('sess-3', 'term:1')).toBeNull();
	});

	it('removeTerminal drops the record', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		expect(registry.listForSession('sess-1')).toHaveLength(1);
		registry.removeTerminal('uuid-a');
		expect(registry.listForSession('sess-1')).toHaveLength(0);
	});

	it('syncSessionTerminals replaces only the targeted session', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-x', 'sess-2'));
		registry.syncSessionTerminals('sess-1', [
			rec('term:2', 'uuid-b', 'sess-1', '/home', 'Alpha'),
			rec('term:3', 'uuid-c', 'sess-1', '/home', 'Beta'),
		]);
		expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual(['term:2', 'term:3']);
		expect(registry.listForSession('sess-2').map((e) => e.id)).toEqual(['term:1']);
	});

	it("removeSession clears all of a session's terminals", () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-c', 'sess-2'));
		registry.removeSession('sess-1');
		expect(registry.listForSession('sess-2')).toHaveLength(1);
		expect(registry.listForSession('sess-1')).toHaveLength(0);
	});

	it('onChange fires on mutations and unsubscribe stops it', () => {
		let calls = 0;
		const off = registry.onChange(() => {
			calls += 1;
		});
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.removeTerminal('uuid-a');
		expect(calls).toBe(2);
		off();
		registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
		expect(calls).toBe(2);
	});
});

// ===== from src/__tests__/main/coworking/coworking-session-id.test.ts =====

describe('resolveOwningMaestroSessionId', () => {
	it('extracts the bare session id from an AI-tab composite', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai-tab1')).toBe('session-123');
	});

	it('strips the forced-parallel suffix', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai-tab1-fp-1712611230000')).toBe(
			'session-123'
		);
	});

	it('handles UUID-shaped session ids with embedded hyphens correctly', () => {
		const sid = '6e58a6c2-2b3f-4f81-9a1e-7b1f3a3a4444';
		expect(resolveOwningMaestroSessionId(`${sid}-ai-default`)).toBe(sid);
		expect(resolveOwningMaestroSessionId(`${sid}-ai-tab-with-dashes`)).toBe(sid);
	});

	it('handles the legacy `-ai` suffix', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai')).toBe('session-123');
	});

	it('passes through non-composite ids unchanged', () => {
		expect(resolveOwningMaestroSessionId('session-123')).toBe('session-123');
		expect(resolveOwningMaestroSessionId('group-chat-abc-moderator-1')).toBe(
			'group-chat-abc-moderator-1'
		);
		expect(resolveOwningMaestroSessionId('session-123-synopsis-1234567890')).toBe(
			'session-123-synopsis-1234567890'
		);
		expect(resolveOwningMaestroSessionId('session-123-batch-1234567890')).toBe(
			'session-123-batch-1234567890'
		);
	});

	it('does NOT misinterpret `-ai` inside the project name as a tab marker', () => {
		// e.g. project named "openai-tools" used as part of a session id
		expect(resolveOwningMaestroSessionId('openai-tools-session')).toBe('openai-tools-session');
	});
});

// ===== from src/__tests__/main/coworking/coworking-types.test.ts =====

describe('coworking-types', () => {
	it('exports stable string constants', () => {
		expect(COWORKING_MCP_SERVER_NAME).toBe('maestro-coworking');
		expect(COWORKING_SOCKET_ENV_VAR).toBe('MAESTRO_COWORKING_SOCKET');
	});

	describe('formatCoworkingId', () => {
		it('returns "term:N" for a positive integer', () => {
			expect(formatCoworkingId(1)).toBe('term:1');
			expect(formatCoworkingId(42)).toBe('term:42');
		});
	});

	describe('parseCoworkingId', () => {
		it('returns the numeric id for valid input', () => {
			expect(parseCoworkingId('term:1')).toBe(1);
			expect(parseCoworkingId('term:99')).toBe(99);
		});

		it('returns null for invalid input', () => {
			expect(parseCoworkingId('bogus')).toBeNull();
			expect(parseCoworkingId('term:')).toBeNull();
			expect(parseCoworkingId('term:abc')).toBeNull();
			expect(parseCoworkingId('term:0')).toBeNull();
			expect(parseCoworkingId('term:-1')).toBeNull();
			expect(parseCoworkingId('term:1.5')).toBeNull();
		});
	});
});

// ===== from src/__tests__/main/coworking/pid-resolution-windows.test.ts =====

type GetParentPid = typeof getParentPid;

/** Fresh module instance so the module-level `windowsPidBackend` cache resets.
 *  Static import cannot work here: it would share one cached backend across
 *  every test, making the probe-order assertions meaningless. */
async function importFreshGetParentPid(): Promise<GetParentPid> {
	vi.resetModules();
	const mod = await import('../../../main/coworking/pid-resolution');
	return mod.getParentPid;
}

/** Binaries execFile was invoked with, in call order. */
function invokedBinaries(): string[] {
	return execFileImpl.mock.calls.map((call) => String(call[0]));
}

describe('getParentPid Windows backend fallback', () => {
	beforeEach(() => {
		execFileImpl.mockReset();
	});

	it('uses wmic when it works and caches that backend for later calls', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockResolvedValue({ stdout: 'ParentProcessId=321\r\n' });

		expect(await getParentPidFresh(500)).toBe(321);
		expect(await getParentPidFresh(600)).toBe(321);
		// Both lookups went to wmic; PowerShell was never probed.
		expect(invokedBinaries()).toEqual(['wmic', 'wmic']);
	});

	it('falls back to PowerShell CIM when wmic is missing and caches the fallback', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockImplementation((file: string) => {
			if (file === 'wmic') throw Object.assign(new Error('spawn wmic ENOENT'), { code: 'ENOENT' });
			return { stdout: '777\r\n' };
		});

		expect(await getParentPidFresh(500)).toBe(777);
		// First call probes wmic, fails, lands on PowerShell.
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);

		// Second call skips the dead wmic probe entirely (backend cached).
		expect(await getParentPidFresh(600)).toBe(777);
		expect(invokedBinaries()).toEqual(['wmic', 'powershell', 'powershell']);
	});

	it('returns null (fail-closed) when both backends fail', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockImplementation(() => {
			throw new Error('spawn failure');
		});

		expect(await getParentPidFresh(500)).toBeNull();
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);
	});

	it('returns null when a cached backend later fails, without throwing', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		// Cache the wmic backend with one good lookup...
		execFileImpl.mockResolvedValueOnce({ stdout: 'ParentProcessId=42\r\n' });
		expect(await getParentPidFresh(500)).toBe(42);
		// ...then have it blow up: fail-closed null, no cross-backend retry storm.
		execFileImpl.mockImplementation(() => {
			throw new Error('wmic broke mid-flight');
		});
		expect(await getParentPidFresh(600)).toBeNull();
	});

	it('rejects non-positive and non-integer pids before spawning anything', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		expect(await getParentPidFresh(0)).toBeNull();
		expect(await getParentPidFresh(-5)).toBeNull();
		expect(await getParentPidFresh(1)).toBeNull();
		expect(await getParentPidFresh(2.5)).toBeNull();
		expect(execFileImpl).not.toHaveBeenCalled();
	});

	it('parses unparseable backend output as null instead of a bogus pid', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockResolvedValue({ stdout: 'No Instance(s) Available.\r\n' });
		expect(await getParentPidFresh(500)).toBeNull();
	});
});

// ===== from src/__tests__/main/coworking/pid-resolution.test.ts =====

describe('resolveSessionFromPidWalk', () => {
	it('returns the session id when the start pid is directly known', async () => {
		const lookup = vi.fn((pid: number) => (pid === 100 ? 'sess-A' : null));
		const getParent = vi.fn(async () => null);

		expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBe('sess-A');
		expect(lookup).toHaveBeenCalledTimes(1);
		// We hit on first try, so the walk does not consult getParent.
		expect(getParent).not.toHaveBeenCalled();
	});

	it('walks up the parent chain until it finds a known ancestor', async () => {
		// PID tree: 500 (mcp) -> 400 (shell) -> 300 (agent CLI, known)
		const lookup = (pid: number) => (pid === 300 ? 'sess-B' : null);
		const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
		const getParent = vi.fn(async (pid: number) => parents[pid] ?? null);

		expect(await resolveSessionFromPidWalk(500, lookup, getParent)).toBe('sess-B');
		// 500 (miss) -> getParent -> 400 (miss) -> getParent -> 300 (hit).
		expect(getParent).toHaveBeenCalledTimes(2);
	});

	it('gives up after MAX_PID_WALK_HOPS hops', async () => {
		const lookup = () => null;
		// An endlessly-deep chain that never resolves: 10 -> 9 -> 8 -> ...
		const getParent = vi.fn(async (pid: number) => (pid > 2 ? pid - 1 : null));

		expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBeNull();
		// The walk inspects start + up to MAX_PID_WALK_HOPS ancestors. Once an
		// iteration finds no match it calls getParent, so the call count is
		// bounded by MAX_PID_WALK_HOPS + 1 (the final hop's parent lookup).
		expect(getParent.mock.calls.length).toBeLessThanOrEqual(MAX_PID_WALK_HOPS + 1);
	});

	it('returns null when start pid is invalid', async () => {
		const lookup = vi.fn(() => 'sess-X');
		const getParent = vi.fn(async () => 200);

		expect(await resolveSessionFromPidWalk(0, lookup, getParent)).toBeNull();
		expect(await resolveSessionFromPidWalk(-1, lookup, getParent)).toBeNull();
		expect(await resolveSessionFromPidWalk(1, lookup, getParent)).toBeNull();
		expect(lookup).not.toHaveBeenCalled();
	});

	it('stops walking when getParent reports a self-cycle or pid<=1', async () => {
		const lookup = () => null;
		// Self-cycle: 50's parent is 50. Walk must terminate, not loop.
		const getParent = vi.fn(async (pid: number) => (pid === 50 ? 50 : null));

		expect(await resolveSessionFromPidWalk(50, lookup, getParent)).toBeNull();
		expect(getParent).toHaveBeenCalledTimes(1);
	});

	it('stops walking when getParent returns pid 1 (init/launchd)', async () => {
		const lookup = () => null;
		const getParent = vi.fn(async (pid: number) => (pid === 200 ? 1 : null));

		expect(await resolveSessionFromPidWalk(200, lookup, getParent)).toBeNull();
		expect(getParent).toHaveBeenCalledTimes(1);
	});
});
