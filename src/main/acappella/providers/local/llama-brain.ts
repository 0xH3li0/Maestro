/**
 * Local Conductor Brain on Qwen3 1.7B, through the Local Models text service.
 *
 * **The model is not this provider's to own.** Loading a 1.1 GB GGUF takes
 * seconds and holds a gigabyte of RAM, and housekeeping tasks (tab naming, AI
 * command suggestions) can run on the same model. So the provider asks the
 * app-wide `LocalTextEngine` (`local-models/text-gen.ts`) for each turn: warm
 * within a conversation, freed after the engine's idle window, and shared, so a
 * tab name generated mid-conversation does not open a second copy.
 *
 * **Routing is grammar-constrained.** The engine compiles the shared
 * `RouteDecision` JSON Schema into a llama.cpp grammar, which makes the model
 * structurally incapable of emitting a malformed decision. It is still run
 * through `parseRouteDecision`, because a grammar guarantees a well-formed
 * `sessionId` and not a real one, and the roster is the only thing that knows the
 * difference.
 */

import { QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';
import { QWEN3_BRAIN_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import { ROUTE_DECISION_JSON_SCHEMA } from '../../../../shared/acappella/route-decision';
import { isLocalModelError } from '../../../local-models/errors';
import { getLocalTextEngine, type LocalTextEngine } from '../../../local-models/text-gen';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	converseSystemPrompt,
	limitSpokenReply,
	parseRouteDecision,
	routeSystemPrompt,
} from '../brain-prompt';
import { voiceErrorFromLocalModel } from './runtime';

const ROUTE_MAX_TOKENS = 400;
const CONVERSE_MAX_TOKENS = 300;

export interface LlamaBrainOptions {
	/** Injected in tests; production shares the app-wide engine. */
	engine?: LocalTextEngine;
}

export class LlamaBrainProvider implements BrainProvider {
	readonly id = QWEN3_BRAIN_PROVIDER_ID;
	readonly label = 'Qwen3 1.7B (local)';
	readonly tier = 'local' as const;

	private readonly engine: LocalTextEngine;

	constructor(options: LlamaBrainOptions = {}) {
		this.engine = options.engine ?? getLocalTextEngine();
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const raw = await this.generate(
			routeSystemPrompt(),
			buildRouteUserPrompt(input, context),
			ROUTE_MAX_TOKENS,
			ROUTE_DECISION_JSON_SCHEMA
		);
		return parseRouteDecision(raw, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const raw = await this.generate(
			converseSystemPrompt(),
			buildConverseUserPrompt(agentText, context),
			CONVERSE_MAX_TOKENS
		);
		return limitSpokenReply(raw, context.maxSentences);
	}

	/**
	 * Free the model now, on pipeline teardown. Only when Qwen3 is the resident
	 * model: voice ending must not evict a different model a housekeeping task
	 * loaded.
	 */
	async unload(): Promise<void> {
		await this.engine.unload(QWEN3_1_7B_ID);
	}

	/** True while the model is resident. Read by the metrics panel and by tests. */
	get isLoaded(): boolean {
		return this.engine.loadedModelId === QWEN3_1_7B_ID;
	}

	/** One turn, with the core's classified failure restated as this provider's. */
	private async generate(
		system: string,
		prompt: string,
		maxTokens: number,
		jsonSchema?: Record<string, unknown>
	): Promise<string> {
		try {
			const reply = await this.engine.generate(QWEN3_1_7B_ID, {
				system,
				prompt,
				maxTokens,
				// Deterministic, for the same reason the hosted Brains are: a misroute
				// that cannot be reproduced cannot be fixed.
				temperature: 0,
				...(jsonSchema ? { jsonSchema } : {}),
			});
			return reply.text;
		} catch (error) {
			if (isLocalModelError(error)) throw voiceErrorFromLocalModel(error, this.id);
			throw error;
		}
	}
}
