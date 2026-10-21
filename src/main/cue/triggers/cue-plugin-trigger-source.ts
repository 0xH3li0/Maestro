import {
	CUE_EVENT_TYPES,
	type CueEvent,
	type CuePluginSource,
} from '../../../shared/cue/contracts';
import { parseCuePluginSource } from '../../../shared/plugins/plugin-json';
export { parseCuePluginSource } from '../../../shared/plugins/plugin-json';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

export interface PluginCueHost {
	register(ctx: CueTriggerSourceContext, source: CuePluginSource): () => void;
	authorize(event: CueEvent, agentId: string, subscriptionName: string, queued: boolean): boolean;
}
let host: PluginCueHost | undefined;
export function configurePluginCueHost(value: PluginCueHost | undefined): void {
	host = value;
}
export function authorizePluginCueEvent(
	event: CueEvent,
	agentId: string,
	name: string,
	queued = true
): boolean {
	if (!CUE_EVENT_TYPES.includes(event.type)) return false;
	if (event.type !== 'plugin.event') return event.pluginSource === undefined;
	try {
		return host?.authorize(event, agentId, name, queued) === true;
	} catch {
		return false;
	}
}
export function isDurableCueEvent(event: CueEvent): boolean {
	return event.type === 'plugin.event';
}
export function createCuePluginTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	let source: CuePluginSource;
	try {
		source = parseCuePluginSource(ctx.subscription.plugin);
	} catch {
		return null;
	}
	let unregister: (() => void) | undefined;
	return {
		start() {
			if (!unregister && host) unregister = host.register(ctx, source);
		},
		stop() {
			unregister?.();
			unregister = undefined;
		},
		nextTriggerAt: () => null,
	};
}
