/**
 * The Maestro system prompt assembler (pure, bundle-safe).
 *
 * Every Maestro-spawned agent gets the same system prompt: the
 * `maestro-system-prompt` template, then any role sections (the Pianola manager
 * instructions), then one section per enabled first-party plugin that declares
 * a `systemPromptSection` (see `FirstPartyPluginDefinition`). Three builders
 * resolve the inputs in their own process and hand them here:
 *
 * - renderer: `prepareMaestroSystemPrompt` (src/renderer/utils/spawnHelpers.ts)
 * - CLI: `prepareMaestroSystemPromptCli` (src/cli/services/system-prompt.ts)
 * - main: `buildMaestroSystemPromptForSession` (src/main/utils/maestro-system-prompt.ts),
 *   used by Cue runs and Group Chat
 *
 * Inputs are already-resolved strings, so nothing here touches IPC, disk, or
 * Node built-ins. Keeping the ordering, separator, and per-section
 * substitution in one place is what stops the three builders from drifting.
 *
 * Prompt caching: providers cache the system prompt as a PREFIX, so one byte
 * that changes per turn invalidates everything after it. `{{RECENT_TIMELINE}}`
 * is the only per-turn value, so wherever the template or a section names it,
 * the assembler writes a fixed pointer there and renders the timeline itself as
 * the last section. Everything above it stays byte-identical between turns.
 */

import { resolveEncoreFeatures } from './encoreFeatureDefaults';
import { FIRST_PARTY_PLUGIN_DEFINITIONS, type FirstPartyEncoreFlag } from './plugins/first-party';
import { substituteTemplateVariables, type TemplateContext } from './templateVariables';

/** Separator placed between the base prompt and each appended section. */
export const MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR = '\n\n---\n\n';

/** What `{{RECENT_TIMELINE}}` reads as in place; the timeline itself goes last. */
export const RECENT_TIMELINE_POINTER =
	'Listed under **Recent Timeline**, the last section of this prompt.';

/** Heading of the per-turn section the assembler appends after every stable one. */
export const RECENT_TIMELINE_SECTION_HEADING = '## Recent Timeline';

// Same match as `substituteTemplateVariables` (case-insensitive).
const RECENT_TIMELINE_TOKEN = /\{\{RECENT_TIMELINE\}\}/gi;

/** A plugin section to load: which plugin asked, and the core prompt holding its text. */
export interface SystemPromptSectionRef {
	pluginId: string;
	promptId: string;
}

/**
 * The plugin sections every agent spawned right now should carry.
 *
 * Derived from `FIRST_PARTY_PLUGIN_DEFINITIONS`: a plugin contributes when its
 * Encore flag is on and it declares a `systemPromptSection`. `localOnly`
 * sections are dropped for SSH-remote agents, whose shell cannot reach paths on
 * the Maestro machine. `encoreFeatures` is whatever the caller has (the raw
 * settings value is fine): it goes through `resolveEncoreFeatures`, so a key
 * that was never persisted falls back to its default instead of reading as off.
 *
 * A `requiresReady` section also needs its flag in `readyFlags`: the builder
 * names the features whose setup it has confirmed is complete. Leaving the list
 * out drops every such section, so a builder that cannot tell never advertises
 * a tool that may not work.
 *
 * `sectionsOnly` marks a spawn with no Maestro agent behind it (the Group Chat
 * moderator): `agentOnly` sections are dropped for it.
 */
export function systemPromptSectionsFor(
	encoreFeatures: unknown,
	opts: { isSsh: boolean; readyFlags?: readonly FirstPartyEncoreFlag[]; sectionsOnly?: boolean }
): SystemPromptSectionRef[] {
	const flags = resolveEncoreFeatures(encoreFeatures);
	const refs: SystemPromptSectionRef[] = [];
	for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
		const section = def.systemPromptSection;
		if (!section) continue;
		if (!flags[def.encoreFlag]) continue;
		if (section.localOnly && opts.isSsh) continue;
		if (section.agentOnly && opts.sectionsOnly) continue;
		if (section.requiresReady && !opts.readyFlags?.includes(def.encoreFlag)) continue;
		refs.push({ pluginId: def.id, promptId: section.promptId });
	}
	return refs;
}

export interface AssembleMaestroSystemPromptInput {
	/** The `maestro-system-prompt` template text (customizations already applied). */
	template: string;
	/** One context for the base template AND every section. */
	context: TemplateContext;
	/** Role-specific additions (e.g. the Pianola manager prompt). Appended first. */
	roleSections?: ReadonlyArray<string | null | undefined>;
	/** Plugin section texts, in `systemPromptSectionsFor` order. Only the recent timeline follows them. */
	pluginSections?: ReadonlyArray<string | null | undefined>;
}

/**
 * Substitute the template and every section with the same context, then join
 * them with `MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR`. Missing or blank
 * sections are skipped, so a section whose prompt failed to load (or that the
 * user emptied in Maestro Prompts) leaves no stray separator behind.
 *
 * When any of them names `{{RECENT_TIMELINE}}`, the token reads as
 * `RECENT_TIMELINE_POINTER` and the timeline is appended once, after every
 * other section, so the cached prefix never contains it. This holds for a
 * customized template too: placement is the assembler's job, not the author's.
 */
export function assembleMaestroSystemPrompt(input: AssembleMaestroSystemPromptInput): string {
	const { template, context } = input;
	let wantsTimeline = false;
	const substitute = (text: string): string => {
		const hoisted = text.replace(RECENT_TIMELINE_TOKEN, () => {
			wantsTimeline = true;
			return RECENT_TIMELINE_POINTER;
		});
		return substituteTemplateVariables(hoisted, context);
	};
	const parts = [substitute(template)];
	for (const section of [...(input.roleSections ?? []), ...(input.pluginSections ?? [])]) {
		if (!section || !section.trim()) continue;
		const substituted = substitute(section);
		if (substituted.trim()) parts.push(substituted);
	}
	if (wantsTimeline) {
		parts.push(
			`${RECENT_TIMELINE_SECTION_HEADING}\n\n${substituteTemplateVariables('{{RECENT_TIMELINE}}', context)}`
		);
	}
	return parts.join(MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR);
}
