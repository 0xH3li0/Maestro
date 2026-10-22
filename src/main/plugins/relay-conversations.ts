import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { generateUUID } from '../../shared/uuid';
import type { RelayConversationState } from '../../shared/relayConversation';
import {
	buildTabRecord,
	DEFAULT_RULE_CONTEXT,
	DEFAULT_TAB_DEFAULTS,
} from '../../shared/maestro-lib/agents/rules';
import type { StoredSession } from '../stores/types';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { PluginKvStore } from './plugin-kv-store';
import {
	acquireProviderSessionWriter,
	hasProviderSessionWriter,
} from '../utils/provider-session-writer';
import { RELAY_PLUGIN_ID } from '../../shared/plugins/relay-identity';

const liveRelayTurns = new Map<string, AbortController>();

/** The real tab's Stop button cancels the host-owned process through its existing signal. */
export function cancelRelayConversationTurn(processId: string): boolean {
	const controller = liveRelayTurns.get(processId);
	if (!controller) return false;
	controller.abort();
	return true;
}

export interface RelaySendOptions {
	conversationId: string;
	messageId: string;
	sessionId?: string;
}
type SendResult = Awaited<ReturnType<HeadlessAgentRunner>> & {
	conversationId?: string;
	tabId?: string;
	replayed?: boolean;
};
interface Mapping {
	agentId: string;
	conversationId: string;
	tabId: string;
	providerSessionId?: string;
	interrupted?: boolean;
}
interface Receipt {
	promptHash: string;
	messageId: string;
	result?: SendResult;
}
interface RelayTab {
	id: string;
	agentSessionId?: string | null;
	logs: Array<{ id: string; timestamp: number; source: string; text: string }>;
	relayConversation?: RelayConversationState;
	[key: string]: any;
}
export interface RelayConversationDeps {
	baseDir: string;
	getAgent(agentId: string): StoredSession | undefined;
	/** Synchronous read-modify-write, shared with the host's sessions store and lifecycle broadcast. */
	updateAgent(agentId: string, update: (agent: StoredSession) => StoredSession): void;
	run: HeadlessAgentRunner;
	loadTranscript?: (agentId: string, providerSessionId: string) => Promise<RelayTab['logs']>;
	now?: () => number;
	flush?: () => Promise<void>;
}

/** Private, durable Relay identity and idempotency ledger. Never exposed as plugin KV.
 * The sessions store owns transcripts/drafts; this ledger owns identity and execution receipts.
 * An interrupted receipt fails closed on retry: tool work might already have happened.
 */
export class RelayConversations {
	private readonly store: PluginKvStore;
	private readonly queue = createKeyedWriteQueue();
	private readonly pending = new Map<string, number>();
	private readonly now: () => number;
	constructor(private readonly deps: RelayConversationDeps) {
		this.store = new PluginKvStore({
			baseDir: deps.baseDir,
			limits: { maxKeys: 100_000, maxValueBytes: 8 * 1024 * 1024 },
		});
		this.now = deps.now ?? Date.now;
	}
	private key(...parts: string[]): string {
		return createHash('sha256').update(canonicalJson(parts)).digest('hex');
	}
	private read<T>(key: string): T | undefined {
		const value = this.store.get(RELAY_PLUGIN_ID, key);
		return value ? (JSON.parse(value) as T) : undefined;
	}
	private write(key: string, value: unknown): void {
		this.store.set(RELAY_PLUGIN_ID, key, JSON.stringify(value));
	}
	private mapping(agentId: string, opts: RelaySendOptions): Mapping {
		const key = this.key('conversation', agentId, opts.conversationId);
		const existing = this.read<Mapping>(key);
		if (existing?.interrupted)
			throw new Error(
				'Previous Relay execution is uncertain; inspect the provider session before continuing'
			);
		if (existing) return existing;
		const agent = this.deps.getAgent(agentId);
		if (!agent) throw new Error('Relay agent not found');
		const tabs = (agent.aiTabs ?? []) as RelayTab[];
		const matches = opts.sessionId ? tabs.filter((t) => t.agentSessionId === opts.sessionId) : [];
		if (matches.length > 1) throw new Error('Ambiguous Relay provider/tab mapping');
		if (
			matches[0]?.relayConversation &&
			matches[0].relayConversation.conversationId !== opts.conversationId
		)
			throw new Error('Provider session already maps to another Relay conversation');
		// Also reject a closed/archived conversation claimed under a second transport id.
		for (const storedKey of this.store.keys(RELAY_PLUGIN_ID)) {
			const stored = this.read<Mapping>(storedKey);
			if (
				opts.sessionId &&
				stored?.agentId === agentId &&
				stored.providerSessionId === opts.sessionId &&
				stored.conversationId !== opts.conversationId
			)
				throw new Error('Provider session already maps to another Relay conversation');
		}
		const mapping: Mapping = {
			agentId,
			conversationId: opts.conversationId,
			tabId: matches[0]?.id ?? generateUUID(),
			providerSessionId: opts.sessionId,
		};
		this.write(key, mapping);
		return mapping;
	}
	private patch(
		mapping: Mapping,
		patch: Partial<RelayTab>,
		relay: Partial<RelayConversationState>,
		log?: RelayTab['logs'][number]
	): void {
		this.deps.updateAgent(mapping.agentId, (agent) => {
			const tabs = (agent.aiTabs ?? []) as RelayTab[];
			// History's resume path may have reopened the same provider after the tab was closed.
			const current =
				tabs.find((t) => t.id === mapping.tabId) ??
				(mapping.providerSessionId
					? tabs.find((t) => t.agentSessionId === mapping.providerSessionId)
					: undefined);
			if (current && current.id !== mapping.tabId) {
				mapping.tabId = current.id;
				this.write(this.key('conversation', mapping.agentId, mapping.conversationId), mapping);
			}
			const fresh = buildTabRecord(
				{ ...DEFAULT_RULE_CONTEXT, newId: () => mapping.tabId, now: this.now },
				DEFAULT_TAB_DEFAULTS
			);
			const tab = {
				...fresh,
				...current,
				origin: 'relay',
				...patch,
				agentSessionId: mapping.providerSessionId ?? current?.agentSessionId ?? null,
				relayConversation: {
					conversationId: mapping.conversationId,
					status: 'idle',
					lastActivityAt: this.now(),
					...current?.relayConversation,
					...relay,
				},
				logs: patch.logs ?? current?.logs ?? [],
			} as RelayTab;
			if (log && !tab.logs.some((row) => row.id === log.id)) tab.logs = [...tab.logs, log];
			return {
				...agent,
				aiTabs: current ? tabs.map((t) => (t.id === current.id ? tab : t)) : [...tabs, tab],
				unifiedTabOrder: (agent.unifiedTabOrder ?? []).some(
					(ref: { type: string; id: string }) => ref.type === 'ai' && ref.id === tab.id
				)
					? agent.unifiedTabOrder
					: [...(agent.unifiedTabOrder ?? []), { type: 'ai', id: tab.id }],
			};
		});
	}
	async send(
		agentId: string,
		prompt: string,
		opts: RelaySendOptions,
		signal: AbortSignal,
		onProgress: Parameters<HeadlessAgentRunner>[5],
		authorize: () => void
	): Promise<SendResult> {
		const conversationKey = this.key('conversation', agentId, opts.conversationId);
		this.pending.set(conversationKey, (this.pending.get(conversationKey) ?? 0) + 1);
		try {
			return await this.queue.enqueue(conversationKey, async () => {
				authorize();
				if (signal.aborted) throw new Error('Relay send cancelled');
				const receiptKey = this.key('message', agentId, opts.conversationId, opts.messageId);
				const hash = this.key(prompt);
				const previous = this.read<Receipt>(receiptKey);
				if (previous) {
					if (previous.promptHash !== hash)
						throw new Error('Relay messageId reused with different content');
					return {
						...(previous.result ?? {
							success: false,
							response: null,
							sessionId: null,
							error: 'Previous Relay execution interrupted; inspect conversation before retrying',
						}),
						replayed: true,
					};
				}
				const mapping = this.mapping(agentId, opts);
				const tab = (this.deps.getAgent(agentId)?.aiTabs as RelayTab[] | undefined)?.find(
					(t) => t.id === mapping.tabId
				);
				if (!tab && mapping.providerSessionId && this.deps.loadTranscript) {
					const logs = await this.deps.loadTranscript(agentId, mapping.providerSessionId);
					this.patch(mapping, { logs }, {});
				}
				// Desktop continuation may have updated the provider id; the live tab is authoritative.
				mapping.providerSessionId = tab?.agentSessionId ?? mapping.providerSessionId;
				this.write(receiptKey, { promptHash: hash, messageId: opts.messageId } satisfies Receipt);
				this.patch(
					mapping,
					{ hidden: false, hasUnread: true },
					{
						messageId: opts.messageId,
						status: 'queued',
						completedAt: undefined,
						archivedAt: undefined,
						error: undefined,
						lastActivityAt: this.now(),
					},
					{ id: `${receiptKey}:user`, timestamp: this.now(), source: 'user', text: prompt }
				);
				await this.deps.flush?.();
				const agent = this.deps.getAgent(agentId)!;
				const controller = new AbortController();
				const abort = () => controller.abort();
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) controller.abort();
				const processId = `${agentId}-ai-${mapping.tabId}`;
				liveRelayTurns.set(processId, controller);
				let release = () => {};
				try {
					release = await acquireProviderSessionWriter(
						agent.toolType,
						processId,
						mapping.providerSessionId,
						controller.signal
					);
					authorize();
					if (controller.signal.aborted) throw new Error('Relay send cancelled');
					const current = (this.deps.getAgent(agentId)?.aiTabs as RelayTab[] | undefined)?.find(
						(t) => t.id === mapping.tabId
					);
					mapping.providerSessionId = current?.agentSessionId ?? mapping.providerSessionId;
					mapping.interrupted = true;
					this.write(conversationKey, mapping);
					this.patch(mapping, {}, { status: 'running' });
					const result = await this.deps.run(
						agentId,
						prompt,
						mapping.providerSessionId,
						controller.signal,
						'relay',
						onProgress
					);
					if (result.sessionId) mapping.providerSessionId = result.sessionId;
					if (mapping.providerSessionId) mapping.interrupted = false;
					this.write(conversationKey, mapping);
					const returned: SendResult = {
						...result,
						conversationId: opts.conversationId,
						tabId: mapping.tabId,
					};
					this.patch(
						mapping,
						{ hasUnread: true },
						{
							status: result.success ? 'idle' : 'error',
							lastActivityAt: this.now(),
							error: result.error,
						},
						{
							id: `${receiptKey}:answer`,
							timestamp: this.now(),
							source: result.success ? 'stdout' : 'error',
							text: result.response ?? result.error ?? 'Relay run failed',
						}
					);
					await this.deps.flush?.();
					// Persist outcome before releasing it. A replay never runs the provider again.
					this.write(receiptKey, {
						promptHash: hash,
						messageId: opts.messageId,
						result: returned,
					} satisfies Receipt);
					authorize();
					return returned;
				} catch (error) {
					this.patch(
						mapping,
						{},
						{ status: 'error', error: String(error), lastActivityAt: this.now() }
					);
					throw error;
				} finally {
					signal.removeEventListener('abort', abort);
					if (liveRelayTurns.get(processId) === controller) liveRelayTurns.delete(processId);
					release();
				}
			});
		} finally {
			const remaining = (this.pending.get(conversationKey) ?? 1) - 1;
			if (remaining) this.pending.set(conversationKey, remaining);
			else this.pending.delete(conversationKey);
		}
	}
	/** Adopt only a plugin's explicitly identified real thread, without starting a turn.
	 * Existing archived tabs stay archived; an intentional manual close is also kept.
	 */
	async restore(
		agentId: string,
		conversationId: string,
		providerSessionId: string
	): Promise<SendResult> {
		const key = this.key('conversation', agentId, conversationId);
		return this.queue.enqueue(key, async () => {
			const known = this.read<Mapping>(key);
			const mapping = this.mapping(agentId, {
				conversationId,
				messageId: '',
				sessionId: providerSessionId,
			});
			const tab = (this.deps.getAgent(agentId)?.aiTabs as RelayTab[] | undefined)?.find(
				(t) => t.id === mapping.tabId
			);
			if (!known && !tab) {
				const logs = (await this.deps.loadTranscript?.(agentId, providerSessionId)) ?? [];
				this.patch(mapping, { logs }, {});
			} else if (!known && tab) this.patch(mapping, {}, {});
			await this.deps.flush?.();
			return {
				success: true,
				response: null,
				sessionId: mapping.providerSessionId ?? null,
				tabId: mapping.tabId,
				conversationId,
			};
		});
	}
	complete(agentId: string, conversationId: string, messageId: string): void {
		const key = this.key('conversation', agentId, conversationId);
		if (this.pending.has(key)) throw new Error('Relay conversation has pending messages');
		const mapping = this.read<Mapping>(key);
		const receipt = this.read<Receipt>(this.key('message', agentId, conversationId, messageId));
		const agent = this.deps.getAgent(agentId);
		const tab = (agent?.aiTabs as RelayTab[] | undefined)?.find((t) => t.id === mapping?.tabId);
		if (
			!mapping ||
			!tab ||
			!receipt?.result?.success ||
			hasProviderSessionWriter(
				agent!.toolType,
				`${agentId}-ai-${tab.id}`,
				mapping.providerSessionId
			) ||
			tab.logs.at(-1)?.id !== `${this.key('message', agentId, conversationId, messageId)}:answer` ||
			tab.relayConversation?.messageId !== messageId ||
			tab.relayConversation.status !== 'idle' ||
			tab.state === 'busy' ||
			agent?.executionQueue?.some((item: { tabId?: string }) => item.tabId === tab.id)
		)
			throw new Error('Relay completion is stale or the conversation has unfinished work');
		if (!tab.relayConversation.completedAt) this.patch(mapping, {}, { completedAt: this.now() });
	}
	/** Host restart cannot turn an unfinished provider run into a completed task. */
	reconcileInterrupted(): void {
		for (const key of this.store.keys(RELAY_PLUGIN_ID)) {
			const mapping = this.read<Mapping>(key);
			if (!mapping?.tabId || !mapping.agentId || !mapping.conversationId) continue;
			const tab = (this.deps.getAgent(mapping.agentId)?.aiTabs as RelayTab[] | undefined)?.find(
				(t) => t.id === mapping.tabId
			);
			if (
				tab?.relayConversation?.status === 'running' ||
				tab?.relayConversation?.status === 'queued'
			)
				this.patch(
					mapping,
					{},
					{
						status: 'error',
						completedAt: undefined,
						error: 'Host restarted during Relay execution; inspect before retrying',
					}
				);
		}
	}
}
