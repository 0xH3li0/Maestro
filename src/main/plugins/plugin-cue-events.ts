/** Authenticated opaque plugin event sources. No mail producer, cursor or account logic. */
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { CueEvent, CuePluginSource } from '../../shared/cue/contracts';
import {
	PLUGIN_TOPIC_PATTERN,
	type PluginConsumer,
	type PluginReceipt,
} from '../../shared/plugins/primitives';
import type { PluginCueHost } from '../cue/triggers/cue-plugin-trigger-source';
import type { CueTriggerSourceContext } from '../cue/triggers/cue-trigger-source';
import { passesFilter } from '../cue/triggers/cue-trigger-filter';
import type { AuthorizationStore, AuthIdentity } from './authorization-ledger';
import type { PluginToolRunIdentity } from './plugin-tool-run-identity';
import type { PluginPrimitiveLifetime } from './plugin-tls';
import {
	PluginAuthorityError,
	assertPluginAuthority,
	pluginJson,
	pluginRequest,
} from './plugin-authority';

interface Consumer {
	id: string;
	ctx: CueTriggerSourceContext;
	source: CuePluginSource;
	controller: AbortController;
}
interface Lease {
	consumer: Consumer;
	pluginId: string;
	generation: string;
	invocationId: string;
	run: string;
	recordRevision: string;
}
export interface PluginEventReceiptRow {
	receiptId: string;
	payloadHash: string;
	proof: string;
}
export interface PluginCueEventsDeps {
	store: AuthorizationStore;
	identity: PluginToolRunIdentity;
	identityFor(pluginId: string, queued?: boolean): AuthIdentity;
	capture(pluginId: string): PluginPrimitiveLifetime;
	assertAllowed(pluginId: string, topic: string, queued?: boolean): void;
	assertReceiptCapacity(pluginId: string): void;
	readReceipt(pluginId: string, id: string): PluginEventReceiptRow | null;
	writeReceipt(pluginId: string, id: string, row: PluginEventReceiptRow): void;
}
export class PluginCueEvents implements PluginCueHost {
	private readonly consumers = new Map<string, Consumer>();
	private readonly leases = new Map<string, Lease>();
	constructor(private readonly deps: PluginCueEventsDeps) {}
	register(ctx: CueTriggerSourceContext, source: CuePluginSource): () => void {
		if (this.consumers.size >= 512) throw new PluginAuthorityError('PLUGIN_LIMIT');
		const id = createHash('sha256')
			.update(canonicalJson([ctx.session.id, ctx.subscription.name, source]))
			.digest('hex');
		if (this.consumers.has(id)) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		const consumer = { id, ctx, source, controller: new AbortController() };
		this.consumers.set(id, consumer);
		return () => {
			if (this.consumers.get(id) !== consumer) return;
			this.consumers.delete(id);
			consumer.controller.abort();
		};
	}
	private consumerEligible(c: Consumer, pluginId: string): boolean {
		if (
			this.consumers.get(c.id) !== c ||
			c.controller.signal.aborted ||
			c.source.pluginId !== pluginId ||
			!c.ctx.enabled() ||
			c.ctx.subscription.enabled === false
		)
			return false;
		// Narrow first contract: one explicit consumer owner, no fan-out or non-durable gates.
		if (
			c.ctx.subscription.fan_out?.length ||
			('gate' in c.ctx.subscription && c.ctx.subscription.gate) ||
			('screen_injection' in c.ctx.subscription && c.ctx.subscription.screen_injection)
		)
			return false;
		return true;
	}
	private checkConsumer(c: Consumer, pluginId: string, queued = false): void {
		if (!this.consumerEligible(c, pluginId)) throw new PluginAuthorityError('PLUGIN_DENIED');
		assertPluginAuthority(() => this.deps.assertAllowed(pluginId, c.source.topic, queued));
		this.deps.store.assertPluginPersistent(pluginId, this.deps.identityFor(pluginId, queued));
	}
	list(pluginId: string, params: unknown): PluginConsumer[] {
		const p = pluginRequest(params, ['topic']);
		if (typeof p.topic !== 'string' || !PLUGIN_TOPIC_PATTERN.test(p.topic))
			throw new PluginAuthorityError('PLUGIN_INVALID');
		assertPluginAuthority(() => this.deps.assertAllowed(pluginId, p.topic as string));
		this.deps.store.assertPluginPersistent(pluginId, this.deps.identityFor(pluginId));
		const result: PluginConsumer[] = [];
		for (const c of this.consumers.values()) {
			if (
				c.source.pluginId !== pluginId ||
				c.source.topic !== p.topic ||
				!this.consumerEligible(c, pluginId)
			)
				continue;
			this.checkConsumer(c, pluginId);
			result.push({
				consumerId: c.id,
				callerAgentId: c.ctx.session.id,
				config: pluginJson(c.source.config),
			});
		}
		return result;
	}
	begin(pluginId: string, params: unknown): { invocationId: string; callerAgentId: string } {
		const p = pluginRequest(params, ['consumerId']);
		const c = typeof p.consumerId === 'string' ? this.consumers.get(p.consumerId) : undefined;
		if (!c) throw new PluginAuthorityError('PLUGIN_DENIED');
		const lifetime = this.deps.capture(pluginId);
		const signal = AbortSignal.any([c.controller.signal, lifetime.signal]);
		const check = () => {
			assertPluginAuthority(lifetime.assertActive);
			this.checkConsumer(c, pluginId);
			if (signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
		};
		check();
		const run = this.deps.identity.issue(c.ctx.session.id, { signal, assertActive: check }, 30000);
		try {
			const handle = this.deps.identity.issueInvocation(
				this.deps.identity.resolveVerified(run),
				pluginId,
				{ signal, assertActive: check }
			);
			const lease = {
				consumer: c,
				pluginId,
				generation: lifetime.generation,
				invocationId: handle,
				run,
				recordRevision: this.deps.store.pluginRecordRevision(
					pluginId,
					this.deps.identityFor(pluginId)
				),
			};
			this.leases.set(handle, lease);
			this.deps.identity.resolveInvocation(pluginId, handle).signal.addEventListener(
				'abort',
				() => {
					this.leases.delete(handle);
					this.deps.identity.revoke(run);
				},
				{ once: true }
			);
			return { invocationId: handle, callerAgentId: c.ctx.session.id };
		} catch (error) {
			this.deps.identity.revoke(run);
			throw error;
		}
	}
	private checkLease(pluginId: string, lease: Lease): void {
		if (
			this.leases.get(lease.invocationId) !== lease ||
			lease.pluginId !== pluginId ||
			this.deps.capture(pluginId).generation !== lease.generation
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		this.deps.identity.resolveInvocation(pluginId, lease.invocationId).assertActive();
		this.checkConsumer(lease.consumer, pluginId);
		if (
			lease.recordRevision !==
			this.deps.store.pluginRecordRevision(pluginId, this.deps.identityFor(pluginId))
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
	}
	assertInvocation(pluginId: string, invocationId: unknown): void {
		const lease = typeof invocationId === 'string' ? this.leases.get(invocationId) : undefined;
		if (!lease) throw new PluginAuthorityError('PLUGIN_DENIED');
		this.checkLease(pluginId, lease);
	}
	publish(pluginId: string, params: unknown): PluginReceipt {
		const p = pluginRequest(params, ['invocationId', 'eventId', 'metadata']);
		if (
			typeof p.invocationId !== 'string' ||
			typeof p.eventId !== 'string' ||
			!/^[a-zA-Z0-9._:-]{1,128}$/.test(p.eventId)
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const metadata = pluginJson(p.metadata);
		const lease = this.leases.get(p.invocationId);
		if (!lease) throw new PluginAuthorityError('PLUGIN_DENIED');
		this.checkLease(pluginId, lease);
		const c = lease.consumer,
			identity = this.deps.identityFor(pluginId);
		const id = createHash('sha256')
			.update(canonicalJson([pluginId, identity, c.id, p.eventId]))
			.digest('hex');
		const payloadHash = createHash('sha256').update(canonicalJson(metadata)).digest('hex');
		const old = this.deps.readReceipt(pluginId, id);
		this.checkLease(pluginId, lease);
		if (old) {
			const expected = this.deps.store.pluginEventProof(
				pluginId,
				identity,
				{ id, receiptId: old.receiptId },
				{ payloadHash }
			);
			if (old.payloadHash !== payloadHash || old.proof !== expected)
				throw new PluginAuthorityError('PLUGIN_CONFLICT');
			return { receiptId: old.receiptId, status: 'duplicate' };
		}
		this.deps.assertReceiptCapacity(pluginId);
		this.checkLease(pluginId, lease);
		const source = {
			pluginId,
			topic: c.source.topic,
			consumerId: c.id,
			ownerAgentId: c.ctx.session.id,
			sourceGeneration: lease.generation,
			recordRevision: lease.recordRevision,
			eventId: p.eventId,
		};
		const proof = this.deps.store.pluginEventProof(pluginId, identity, source, metadata);
		const event: CueEvent = {
			id,
			type: 'plugin.event',
			triggerName: c.ctx.subscription.name,
			timestamp: new Date().toISOString(),
			payload: { metadata },
			pluginSource: { ...source, proof },
		};
		this.checkLease(pluginId, lease);
		if (passesFilter(c.ctx.subscription, event, c.ctx.onLog)) {
			const accepted = c.ctx.emit(event);
			if (typeof accepted !== 'number' || accepted !== 1)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
		this.checkLease(pluginId, lease);
		const receiptId = randomBytes(32).toString('hex');
		const row = {
			receiptId,
			payloadHash,
			proof: this.deps.store.pluginEventProof(
				pluginId,
				identity,
				{ id, receiptId },
				{ payloadHash }
			),
		};
		this.deps.writeReceipt(pluginId, id, row);
		this.checkLease(pluginId, lease);
		if (canonicalJson(this.deps.readReceipt(pluginId, id)) !== canonicalJson(row))
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		return { receiptId, status: 'accepted' };
	}
	authorize(event: CueEvent, agentId: string, name: string, queued: boolean): boolean {
		try {
			const e = event.pluginSource;
			if (event.type !== 'plugin.event' || !e || e.ownerAgentId !== agentId) return false;
			const c = this.consumers.get(e.consumerId);
			if (
				!c ||
				c.ctx.subscription.name !== name ||
				c.ctx.session.id !== agentId ||
				c.source.topic !== e.topic
			)
				return false;
			this.checkConsumer(c, e.pluginId, queued);
			if (!queued && this.deps.capture(e.pluginId).generation !== e.sourceGeneration) return false;
			if (Object.keys(event.payload).join(',') !== 'metadata') return false;
			const { proof, ...source } = e;
			if (!/^[0-9a-f]{64}$/.test(proof)) return false;
			const identity = this.deps.identityFor(e.pluginId, queued);
			if (e.recordRevision !== this.deps.store.pluginRecordRevision(e.pluginId, identity))
				return false;
			const expectedId = createHash('sha256')
				.update(canonicalJson([e.pluginId, identity, c.id, e.eventId]))
				.digest('hex');
			if (event.id !== expectedId) return false;
			const expected = this.deps.store.pluginEventProof(
				e.pluginId,
				identity,
				source,
				event.payload.metadata
			);
			return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
		} catch {
			return false;
		}
	}
	stopPlugin(pluginId: string): void {
		for (const lease of [...this.leases.values()])
			if (lease.pluginId === pluginId) this.deps.identity.revoke(lease.run);
	}
}
