// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/storage/base-session-storage.test.ts
//   - src/__tests__/main/storage/claude-session-origins.test.ts
//   - src/__tests__/main/storage/codex-session-storage-messages.test.ts
//   - src/__tests__/main/storage/remote-error-utils.test.ts

import type {
	AgentSessionInfo,
	SessionMessage,
	SessionMessagesResult,
	SessionReadOptions,
} from '../../../main/agents';
import { BaseSessionStorage, SearchableMessage } from '../../../main/storage/base-session-storage';
import {
	backfillClaudeSessionNames,
	mergeClaudeSessionOrigin,
	setClaudeSessionOrigin,
} from '../../../main/storage/claude-session-origins';
import { CodexSessionStorage } from '../../../main/storage/codex-session-storage';
import { isExpectedRemoteError } from '../../../main/storage/remote-error-utils';
import type { ClaudeSessionOriginsData } from '../../../main/stores/types';
import type { SshRemoteConfig, ToolType } from '../../../shared/types';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp' },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	statRemote: vi.fn(),
}));
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		access: vi.fn(),
	},
}));

// ===== from src/__tests__/main/storage/base-session-storage.test.ts =====

// ============================================================
// Concrete subclass for testing
// ============================================================

class TestSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'claude-code';

	/** Inject sessions for listSessions */
	sessions: AgentSessionInfo[] = [];

	/** Inject searchable messages per session */
	searchableMessages: Map<string, SearchableMessage[]> = new Map();

	/** Session IDs that should throw when loading messages */
	failingSessions: Set<string> = new Set();

	async listSessions(
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		return this.sessions;
	}

	async readSessionMessages(
		_projectPath: string,
		_sessionId: string,
		_options?: SessionReadOptions,
		_sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		return { messages: [], total: 0, hasMore: false };
	}

	getSessionPath(
		_projectPath: string,
		_sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: true };
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		if (this.failingSessions.has(sessionId)) {
			throw new Error(`Failed to load messages for ${sessionId}`);
		}
		return this.searchableMessages.get(sessionId) || [];
	}
}

// ============================================================
// Helpers
// ============================================================

function makeSession(id: string, modifiedAt?: string): AgentSessionInfo {
	return {
		sessionId: id,
		projectPath: '/test',
		timestamp: '2025-01-01T00:00:00Z',
		modifiedAt: modifiedAt || '2025-01-01T00:00:00Z',
		firstMessage: `Session ${id}`,
		messageCount: 5,
		sizeBytes: 1024,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 60,
	};
}

function makeMessage(role: 'user' | 'assistant', content: string, index: number): SessionMessage {
	return {
		type: role,
		role,
		content,
		timestamp: '2025-01-01T00:00:00Z',
		uuid: `msg-${index}`,
	};
}

// ============================================================
// Tests
// ============================================================

describe('BaseSessionStorage', () => {
	// ---- paginateSessions (static) ----

	describe('paginateSessions', () => {
		const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s-${i}`));

		it('returns first page with default limit', () => {
			const result = BaseSessionStorage.paginateSessions(sessions);
			expect(result.sessions).toHaveLength(10);
			expect(result.hasMore).toBe(false);
			expect(result.totalCount).toBe(10);
			expect(result.nextCursor).toBeNull();
		});

		it('limits results to specified limit', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, { limit: 3 });
			expect(result.sessions).toHaveLength(3);
			expect(result.hasMore).toBe(true);
			expect(result.totalCount).toBe(10);
			expect(result.nextCursor).toBe('s-2');
		});

		it('uses cursor to start after specified session', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 's-4',
				limit: 3,
			});
			expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-5', 's-6', 's-7']);
			expect(result.hasMore).toBe(true);
		});

		it('returns empty page when cursor is last session', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 's-9',
				limit: 5,
			});
			expect(result.sessions).toHaveLength(0);
			expect(result.hasMore).toBe(false);
		});

		it('resets to start when cursor not found', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 'nonexistent',
				limit: 2,
			});
			expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-0', 's-1']);
		});

		it('handles empty sessions array', () => {
			const result = BaseSessionStorage.paginateSessions([]);
			expect(result.sessions).toHaveLength(0);
			expect(result.hasMore).toBe(false);
			expect(result.totalCount).toBe(0);
			expect(result.nextCursor).toBeNull();
		});
	});

	// ---- applyMessagePagination (static) ----

	describe('applyMessagePagination', () => {
		const messages = Array.from({ length: 30 }, (_, i) =>
			makeMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
		);

		it('returns last 20 messages by default (most recent first)', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages);
			expect(result.messages).toHaveLength(20);
			expect(result.total).toBe(30);
			expect(result.hasMore).toBe(true);
			// Should contain messages 10-29
			expect(result.messages[0].content).toBe('Message 10');
			expect(result.messages[19].content).toBe('Message 29');
		});

		it('applies offset to load older messages', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages, {
				offset: 20,
				limit: 10,
			});
			expect(result.messages).toHaveLength(10);
			expect(result.messages[0].content).toBe('Message 0');
			expect(result.hasMore).toBe(false);
		});

		it('handles offset beyond total', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages, {
				offset: 50,
				limit: 10,
			});
			// When offset >= total, returns empty items but preserves total
			expect(result.messages).toHaveLength(0);
			expect(result.total).toBe(30);
			expect(result.hasMore).toBe(false);
		});

		it('handles empty messages', () => {
			const result = BaseSessionStorage.applyMessagePagination([]);
			expect(result.messages).toHaveLength(0);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('clamps to available messages when limit exceeds total', () => {
			const small = messages.slice(0, 5);
			const result = BaseSessionStorage.applyMessagePagination(small, { limit: 100 });
			expect(result.messages).toHaveLength(5);
			expect(result.hasMore).toBe(false);
		});
	});

	// ---- extractMatchPreview (static) ----

	describe('extractMatchPreview', () => {
		it('extracts asymmetric context around match (short lead, long trail)', () => {
			const text = 'A'.repeat(100) + 'TARGET' + 'B'.repeat(200);
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10, 30);
			// Should include ... prefix, 10 chars before, TARGET, 30 chars after, ... suffix
			expect(preview).toContain('TARGET');
			expect(preview.startsWith('...')).toBe(true);
			expect(preview.endsWith('...')).toBe(true);
			// Trail must be longer than lead so the keyword stays near the left edge.
			const matchIdx = preview.indexOf('TARGET');
			expect(matchIdx).toBeLessThan(preview.length - matchIdx - 'TARGET'.length);
		});

		it('omits leading ellipsis when match is at start', () => {
			const text = 'TARGET' + 'B'.repeat(100);
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10, 30);
			expect(preview.startsWith('TARGET')).toBe(true);
			expect(preview.endsWith('...')).toBe(true);
		});

		it('omits trailing ellipsis when match is at end', () => {
			const text = 'A'.repeat(100) + 'TARGET';
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10, 30);
			expect(preview.startsWith('...')).toBe(true);
			expect(preview.endsWith('TARGET')).toBe(true);
		});

		it('returns empty string when no match', () => {
			const preview = BaseSessionStorage.extractMatchPreview(
				'hello world',
				'hello world',
				'missing',
				7
			);
			expect(preview).toBe('');
		});

		it('handles short text with no ellipsis needed', () => {
			const text = 'find me';
			const preview = BaseSessionStorage.extractMatchPreview(text, text, 'find', 4, 60, 60);
			expect(preview).toBe('find me');
		});

		it('defaults bias the keyword toward the start of the preview', () => {
			const text = 'A'.repeat(500) + 'TARGET' + 'B'.repeat(500);
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6);
			const matchIdx = preview.indexOf('TARGET');
			// With defaults (20 lead, 120 trail), the keyword should land early so it
			// remains visible when the UI truncates with an ellipsis.
			expect(matchIdx).toBeLessThan(preview.length / 2);
		});
	});

	// ---- resolveSearchMode (static) ----

	describe('resolveSearchMode', () => {
		it('returns title match for title mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('title', 'ses-1', true, 3, 2, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'title',
				matchPreview: 'preview',
				matchCount: 1,
			});
		});

		it('returns null when title mode has no title match', () => {
			const result = BaseSessionStorage.resolveSearchMode('title', 'ses-1', false, 0, 5, '');
			expect(result).toBeNull();
		});

		it('returns user match for user mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('user', 'ses-1', false, 3, 0, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'user',
				matchPreview: 'preview',
				matchCount: 3,
			});
		});

		it('returns assistant match for assistant mode', () => {
			const result = BaseSessionStorage.resolveSearchMode(
				'assistant',
				'ses-1',
				false,
				0,
				5,
				'preview'
			);
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'assistant',
				matchPreview: 'preview',
				matchCount: 5,
			});
		});

		it('returns combined match for all mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('all', 'ses-1', true, 3, 2, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'title',
				matchPreview: 'preview',
				matchCount: 5,
			});
		});

		it('returns null for all mode with no matches', () => {
			const result = BaseSessionStorage.resolveSearchMode('all', 'ses-1', false, 0, 0, '');
			expect(result).toBeNull();
		});

		it('prefers title > user > assistant for matchType in all mode', () => {
			// Only user matches
			const r1 = BaseSessionStorage.resolveSearchMode('all', 's', false, 2, 0, '');
			expect(r1?.matchType).toBe('user');

			// Only assistant matches
			const r2 = BaseSessionStorage.resolveSearchMode('all', 's', false, 0, 3, '');
			expect(r2?.matchType).toBe('assistant');
		});
	});

	// ---- listSessionsPaginated (instance) ----

	describe('listSessionsPaginated', () => {
		it('delegates to listSessions and paginates', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = Array.from({ length: 5 }, (_, i) => makeSession(`s-${i}`));

			const result = await storage.listSessionsPaginated('/test', { limit: 2 });
			expect(result.sessions).toHaveLength(2);
			expect(result.hasMore).toBe(true);
			expect(result.totalCount).toBe(5);
		});
	});

	// ---- searchSessions (instance) ----

	describe('searchSessions', () => {
		it('returns empty for empty query', async () => {
			const storage = new TestSessionStorage();
			const results = await storage.searchSessions('/test', '  ', 'all');
			expect(results).toEqual([]);
		});

		it('finds matches in user messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'Fix the authentication bug' },
				{ role: 'assistant', textContent: 'I will fix it' },
			]);

			const results = await storage.searchSessions('/test', 'authentication', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('user');
			expect(results[0].matchCount).toBe(1);
		});

		it('finds matches in assistant messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'help me' },
				{ role: 'assistant', textContent: 'Here is the solution to your problem' },
			]);

			const results = await storage.searchSessions('/test', 'solution', 'assistant');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('assistant');
		});

		it('searches all modes correctly', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'search term here' }]);
			storage.searchableMessages.set('s-2', [{ role: 'assistant', textContent: 'no match here' }]);

			const results = await storage.searchSessions('/test', 'search term', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-1');
		});

		it('is case-insensitive', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'FiX ThE BuG' }]);

			const results = await storage.searchSessions('/test', 'fix the bug', 'user');
			expect(results).toHaveLength(1);
		});

		it('includes match preview', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'Please fix the authentication bug in login' },
			]);

			const results = await storage.searchSessions('/test', 'authentication', 'all');
			expect(results[0].matchPreview).toContain('authentication');
		});

		it('skips sessions with no matching messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);
			storage.searchableMessages.set('s-2', [{ role: 'user', textContent: 'matching query here' }]);

			const results = await storage.searchSessions('/test', 'matching query', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-2');
		});

		it('counts multiple matches in a session', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'fix this bug' },
				{ role: 'assistant', textContent: 'fixed the bug' },
				{ role: 'user', textContent: 'another bug found' },
			]);

			const results = await storage.searchSessions('/test', 'bug', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].matchCount).toBe(3); // 2 user + 1 assistant
		});

		it('matches title from session firstMessage metadata', async () => {
			const storage = new TestSessionStorage();
			// makeSession creates firstMessage: 'Session s-1'
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);

			const results = await storage.searchSessions('/test', 'Session s-1', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('title');
			expect(results[0].matchPreview).toContain('Session s-1');
		});

		it('matches title from sessionName when present', async () => {
			const storage = new TestSessionStorage();
			const session = makeSession('s-1');
			session.sessionName = 'My Custom Session Name';
			storage.sessions = [session];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);

			const results = await storage.searchSessions('/test', 'Custom Session', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('title');
		});

		it('does not match title from user message content', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')]; // firstMessage: 'Session s-1'
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'fix the authentication bug' },
			]);

			// 'authentication' is in user message but not in firstMessage/sessionName
			const results = await storage.searchSessions('/test', 'authentication', 'title');
			expect(results).toHaveLength(0);
		});

		it('continues searching when getSearchableMessages fails for a session', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.failingSessions.add('s-1');
			storage.searchableMessages.set('s-2', [{ role: 'user', textContent: 'search term here' }]);

			const results = await storage.searchSessions('/test', 'search term', 'user');
			// s-1 fails but s-2 still returns results
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-2');
		});

		it('returns empty when all sessions fail to load messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.failingSessions.add('s-1');

			const results = await storage.searchSessions('/test', 'anything', 'all');
			expect(results).toHaveLength(0);
		});
	});
});

// ===== from src/__tests__/main/storage/claude-session-origins.test.ts =====

/** Minimal in-memory electron-store double backed by a plain record. */
function makeOriginsStore(origins: ClaudeSessionOriginsData['origins'] = {}) {
	const data: Record<string, unknown> = { origins };
	const store = {
		data,
		get: vi.fn((key: string, fallback?: unknown) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: unknown) => {
			data[key] = value;
		}),
	};
	return store as typeof store & Store<ClaudeSessionOriginsData>;
}

describe('mergeClaudeSessionOrigin', () => {
	it('keeps fields the patch does not name', () => {
		expect(
			mergeClaudeSessionOrigin(
				{ origin: 'user', sessionName: 'Named', starred: true, contextUsage: 12 },
				{ origin: 'user' }
			)
		).toEqual({ origin: 'user', sessionName: 'Named', starred: true, contextUsage: 12 });
	});

	it('upgrades a bare origin string to a record when a field is added', () => {
		expect(mergeClaudeSessionOrigin('auto', { sessionName: 'Named' })).toEqual({
			origin: 'auto',
			sessionName: 'Named',
		});
	});

	it('defaults a missing record to the user origin', () => {
		expect(mergeClaudeSessionOrigin(undefined, { starred: true })).toEqual({
			origin: 'user',
			starred: true,
		});
	});

	it('stays in the compact string form when only the origin is known', () => {
		expect(mergeClaudeSessionOrigin(undefined, { origin: 'auto' })).toBe('auto');
		expect(mergeClaudeSessionOrigin('user', { origin: 'auto' })).toBe('auto');
	});
});

describe('setClaudeSessionOrigin', () => {
	it('writes the merged record without touching sibling sessions', () => {
		const store = makeOriginsStore({
			'/p': { keep: 'user', target: { origin: 'user', sessionName: 'Named' } },
		});

		setClaudeSessionOrigin(store, '/p', 'target', { starred: true });

		expect(store.data.origins).toEqual({
			'/p': { keep: 'user', target: { origin: 'user', sessionName: 'Named', starred: true } },
		});
	});
});

describe('backfillClaudeSessionNames', () => {
	it('restores the newest recorded name onto records that lost it', () => {
		const store = makeOriginsStore({
			'/p': { 'aaaa-1': 'user', 'bbbb-2': { origin: 'auto', starred: true } },
		});

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'aaaa-1', sessionName: 'Old Name', timestamp: 1 },
			{ agentSessionId: 'aaaa-1', sessionName: 'New Name', timestamp: 2 },
			{ agentSessionId: 'bbbb-2', sessionName: 'Starred One', timestamp: 1 },
		]);

		expect(restored).toBe(2);
		expect(store.data.origins).toEqual({
			'/p': {
				'aaaa-1': { origin: 'user', sessionName: 'New Name' },
				'bbbb-2': { origin: 'auto', starred: true, sessionName: 'Starred One' },
			},
		});
	});

	it('never overwrites a name the store already holds', () => {
		const store = makeOriginsStore({
			'/p': { 'aaaa-1': { origin: 'user', sessionName: 'Current' } },
		});

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'aaaa-1', sessionName: 'Stale', timestamp: 1 },
		]);

		expect(restored).toBe(0);
		expect(store.set).not.toHaveBeenCalled();
	});

	it('skips placeholder labels and sessions the store never tracked', () => {
		const store = makeOriginsStore({ '/p': { 'abcd1234-ffff': 'user' } });

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'abcd1234-ffff', sessionName: 'ABCD1234', timestamp: 1 },
			{ agentSessionId: 'abcd1234-ffff', sessionName: 'New Session', timestamp: 2 },
			{ agentSessionId: 'untracked-1', sessionName: 'Orphan', timestamp: 1 },
			{ sessionName: 'No Id', timestamp: 1 },
		]);

		expect(restored).toBe(0);
		expect(store.data.origins).toEqual({ '/p': { 'abcd1234-ffff': 'user' } });
	});
});

// ===== from src/__tests__/main/storage/codex-session-storage-messages.test.ts =====

/**
 * Create a realistic Codex v0.111.0 session JSONL content
 */
function createSessionContent(): string {
	const lines = [
		// Line 1: session metadata
		JSON.stringify({
			timestamp: '2026-03-08T03:10:29.069Z',
			type: 'session_meta',
			payload: {
				id: '019ccb6c-c0fd-7b70-92b7-558f514099c6',
				timestamp: '2026-03-08T03:10:28.101Z',
				cwd: 'C:\\Users\\test\\project',
				cli_version: '0.111.0',
			},
		}),
		// Line 2: user message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:29.070Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Fix the bug in main.ts' }],
			},
		}),
		// Line 3: assistant message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:33.000Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [
					{
						type: 'output_text',
						text: "I'll review the code first.",
					},
				],
			},
		}),
		// Line 4: function_call
		JSON.stringify({
			timestamp: '2026-03-08T03:10:33.593Z',
			type: 'response_item',
			payload: {
				type: 'function_call',
				name: 'shell_command',
				arguments: '{"command":"cat main.ts","workdir":"C:\\\\Users\\\\test\\\\project"}',
				call_id: 'call_abc123',
			},
		}),
		// Line 5: function_call_output
		JSON.stringify({
			timestamp: '2026-03-08T03:10:40.169Z',
			type: 'response_item',
			payload: {
				type: 'function_call_output',
				call_id: 'call_abc123',
				output: 'Exit code: 0\nWall time: 1 seconds\nOutput:\nconst x = 1;',
			},
		}),
		// Line 6: custom_tool_call (apply_patch)
		JSON.stringify({
			timestamp: '2026-03-08T03:10:41.000Z',
			type: 'response_item',
			payload: {
				type: 'custom_tool_call',
				name: 'apply_patch',
				arguments:
					'{"patch":"--- a/main.ts\\n+++ b/main.ts\\n@@ -1 +1 @@\\n-const x = 1;\\n+const x = 2;"}',
				call_id: 'call_def456',
			},
		}),
		// Line 7: custom_tool_call_output
		JSON.stringify({
			timestamp: '2026-03-08T03:10:42.000Z',
			type: 'response_item',
			payload: {
				type: 'custom_tool_call_output',
				call_id: 'call_def456',
				output: 'Patch applied successfully',
			},
		}),
		// Line 8: final assistant message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:44.000Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Fixed the bug.' }],
			},
		}),
	];
	return lines.join('\n');
}

describe('CodexSessionStorage - readSessionMessages', () => {
	let storage: CodexSessionStorage;

	beforeEach(() => {
		storage = new CodexSessionStorage();
		vi.clearAllMocks();
	});

	it('should parse function_call entries with toolUse', async () => {
		const content = createSessionContent();

		// Mock findSessionFile to return a path
		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		expect(result.messages.length).toBeGreaterThan(0);

		// Find the shell_command tool call message
		const shellMsg = result.messages.find((m) => m.content === 'Tool: shell_command');
		expect(shellMsg).toBeDefined();
		expect(shellMsg!.toolUse).toBeDefined();
		expect(Array.isArray(shellMsg!.toolUse)).toBe(true);

		const toolUseArr = shellMsg!.toolUse as any[];
		expect(toolUseArr.length).toBe(1);
		expect(toolUseArr[0].tool).toBe('shell_command');
		expect(toolUseArr[0].state).toBeDefined();
		expect(toolUseArr[0].state.status).toBe('completed');
		expect(toolUseArr[0].state.input).toBeDefined();
		expect(toolUseArr[0].state.output).toBe(
			'Exit code: 0\nWall time: 1 seconds\nOutput:\nconst x = 1;'
		);
	});

	it('should parse custom_tool_call entries with toolUse', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		const patchMsg = result.messages.find((m) => m.content === 'Tool: apply_patch');
		expect(patchMsg).toBeDefined();
		expect(patchMsg!.toolUse).toBeDefined();

		const toolUseArr = patchMsg!.toolUse as any[];
		expect(toolUseArr[0].tool).toBe('apply_patch');
		expect(toolUseArr[0].state.output).toBe('Patch applied successfully');
	});

	it('should NOT create messages for function_call_output entries', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		// Should have: user msg, assistant msg, shell_command tool, apply_patch tool, final assistant msg = 5
		expect(result.messages.length).toBe(5);

		// Verify no message contains raw output text as content
		const outputMsg = result.messages.find((m) => m.content.includes('Exit code:'));
		expect(outputMsg).toBeUndefined();
	});

	it('should render plain text messages without toolUse', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		const textMsg = result.messages.find((m) => m.content === "I'll review the code first.");
		expect(textMsg).toBeDefined();
		expect(textMsg!.toolUse).toBeUndefined();
	});

	it('toolUse array entries should satisfy ToolCallCard interface', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		// Check all messages with toolUse
		for (const msg of result.messages) {
			if (msg.toolUse) {
				const arr = msg.toolUse as any[];
				expect(Array.isArray(arr)).toBe(true);
				expect(arr.length).toBeGreaterThan(0);

				for (const entry of arr) {
					// Must have 'tool' or 'name' for getToolName()
					expect(entry.tool || entry.name).toBeTruthy();
					// Must have state for ToolCallCard rendering
					expect(entry.state).toBeDefined();
					expect(entry.state.status).toBeDefined();
				}
			}
		}
	});

	it('should handle function_call_output with no matching call_id', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'orphan-test-session',
					timestamp: '2026-03-08T03:10:28.101Z',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			// Output without a preceding tool call
			JSON.stringify({
				timestamp: '2026-03-08T03:10:40.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call_output',
					call_id: 'call_nonexistent',
					output: 'Orphaned output text',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/orphan.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'orphan-session', {
			offset: 0,
			limit: 50,
		});

		// Should create a standalone message with the output text
		const orphanMsg = result.messages.find((m) => m.content === 'Orphaned output text');
		expect(orphanMsg).toBeDefined();
		expect(orphanMsg!.toolUse).toBeUndefined();
	});

	it('should handle empty session file', async () => {
		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/empty.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue('');

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'empty-session', {
			offset: 0,
			limit: 50,
		});

		expect(result.messages).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('should handle session file with only malformed JSON lines', async () => {
		const content = 'not json line 1\nalso not json\n{broken json';

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/bad.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'bad-session', {
			offset: 0,
			limit: 50,
		});

		// Malformed lines should be silently skipped
		expect(result.messages).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('should handle legacy item.completed tool_call and tool_result entries', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'legacy-test',
					timestamp: '2026-03-08T03:10:28.101Z',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:33.000Z',
				type: 'item.completed',
				item: {
					id: 'item_tool1',
					type: 'tool_call',
					tool: 'shell',
					args: { command: ['echo', 'hello'] },
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:34.000Z',
				type: 'item.completed',
				item: {
					id: 'item_result1',
					type: 'tool_result',
					output: 'hello',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/legacy.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'legacy-session', {
			offset: 0,
			limit: 50,
		});

		// Should have tool_call message and tool_result message
		const toolMsg = result.messages.find((m) => m.content === 'Tool: shell');
		expect(toolMsg).toBeDefined();
		expect(toolMsg!.toolUse).toBeDefined();

		const resultMsg = result.messages.find((m) => m.content === 'hello');
		expect(resultMsg).toBeDefined();
	});

	it('should handle function_call_output with empty output string', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'empty-output-test',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:33.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call',
					name: 'write_file',
					arguments: '{"path":"test.txt"}',
					call_id: 'call_empty_out',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:34.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call_output',
					call_id: 'call_empty_out',
					output: '',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/empty-out.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages(
			'C:\\Users\\test\\project',
			'empty-output-session',
			{ offset: 0, limit: 50 }
		);

		// The tool call should exist and have its output merged (even if empty)
		const toolMsg = result.messages.find((m) => m.content === 'Tool: write_file');
		expect(toolMsg).toBeDefined();
		const toolUseArr = toolMsg!.toolUse as any[];
		expect(toolUseArr[0].state.status).toBe('completed');
		expect(toolUseArr[0].state.output).toBe('');
	});
});

// ===== from src/__tests__/main/storage/remote-error-utils.test.ts =====

describe('isExpectedRemoteError', () => {
	it('returns false for empty or missing errors', () => {
		expect(isExpectedRemoteError()).toBe(false);
		expect(isExpectedRemoteError('')).toBe(false);
	});

	it('matches benign not-found and permission phrases', () => {
		expect(isExpectedRemoteError('File not found')).toBe(true);
		expect(isExpectedRemoteError('path not accessible')).toBe(true);
		expect(isExpectedRemoteError('No such file or directory')).toBe(true);
		expect(isExpectedRemoteError('Permission denied')).toBe(true);
		expect(isExpectedRemoteError('Directory does not exist')).toBe(true);
	});

	it('does not match unexpected remote failures', () => {
		expect(isExpectedRemoteError('Connection timed out')).toBe(false);
		expect(isExpectedRemoteError('Host key verification failed')).toBe(false);
	});
});
