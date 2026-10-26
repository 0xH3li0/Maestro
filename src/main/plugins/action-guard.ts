/**
 * ActionGuard - a thin enforcement seam that sits BETWEEN broker-allow and
 * handler-execute. It does NOT decide permission (the PermissionBroker does);
 * it bounds the BLAST RADIUS of an already-permitted verb:
 *  - per-(plugin, capability) sliding-window rate limit,
 *  - per-(plugin, capability) max concurrency,
 *  - audit-BEFORE-action for high-risk verbs (a tripwire, never a substitute for
 *    the gate).
 *
 * Pure given an injected clock + audit sink, so it is unit-testable without
 * Electron. Limits default by capability risk; high-risk verbs are tightly
 * bounded so a compromised-but-permitted plugin cannot fire them in a storm.
 */

import { capabilityRisk, type PluginCapability } from '../../shared/plugins/permissions';
import {
	createSlidingWindowGuard,
	type SlidingWindowGuard,
	type SlidingWindowLimits,
} from '../utils/sliding-window-guard';

type Risk = 'low' | 'medium' | 'high';

/** Per (plugin, capability): the window, the actions it admits, and the in-flight cap. */
export type ActionGuardLimits = SlidingWindowLimits;

/** Default limits by capability risk. High-risk is deliberately tight. */
export const DEFAULT_LIMITS: Record<Risk, ActionGuardLimits> = {
	low: { windowMs: 1000, maxPerWindow: 100, maxConcurrent: 16 },
	medium: { windowMs: 1000, maxPerWindow: 30, maxConcurrent: 8 },
	high: { windowMs: 10_000, maxPerWindow: 10, maxConcurrent: 2 },
};

export interface AuditEntry {
	pluginId: string;
	capability: PluginCapability;
	at: number;
	target?: string;
}

export interface ActionGuardDeps {
	now?: () => number;
	/** Called BEFORE a permitted high-risk action executes. */
	audit?: (entry: AuditEntry) => void;
	limits?: Partial<Record<Risk, ActionGuardLimits>>;
}

export type GuardOutcome = { ok: true; release: () => void } | { ok: false; reason: string };

export class ActionGuard {
	private readonly now: () => number;
	private readonly audit: (entry: AuditEntry) => void;
	private readonly limits: Record<Risk, ActionGuardLimits>;
	private readonly guard: SlidingWindowGuard;

	constructor(deps: ActionGuardDeps = {}) {
		this.now = deps.now ?? Date.now;
		this.audit = deps.audit ?? ((): void => {});
		this.limits = {
			low: deps.limits?.low ?? DEFAULT_LIMITS.low,
			medium: deps.limits?.medium ?? DEFAULT_LIMITS.medium,
			high: deps.limits?.high ?? DEFAULT_LIMITS.high,
		};
		this.guard = createSlidingWindowGuard(this.now);
	}

	/**
	 * Gate one action. On `ok`, the caller MUST call `release()` exactly once when
	 * the action finishes (success or failure) to free the concurrency slot.
	 * Audits BEFORE returning ok for high-risk verbs.
	 */
	begin(pluginId: string, capability: PluginCapability, target?: string): GuardOutcome {
		const risk = capabilityRisk(capability);
		const lim = this.limits[risk];
		const key = `${pluginId}\u0000${capability}`;
		const outcome = this.guard.begin(key, lim);
		if (!outcome.ok) {
			return {
				ok: false,
				reason:
					outcome.limit === 'rate'
						? `rate limit: ${capability} exceeded ${lim.maxPerWindow} per ${lim.windowMs}ms`
						: `concurrency limit: ${capability} has ${outcome.count} in flight (max ${lim.maxConcurrent})`,
			};
		}

		// Audit before the action runs - high-risk only (low/medium are too chatty
		// to log per-call and are not individually security-relevant).
		if (risk === 'high') {
			this.audit({ pluginId, capability, at: this.now(), ...(target ? { target } : {}) });
		}

		return { ok: true, release: outcome.release };
	}
}
