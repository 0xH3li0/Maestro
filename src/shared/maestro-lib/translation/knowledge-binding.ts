import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
	hasEmbeddedSystemPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
} from '../../embeddedSystemPrompt';

export const TRANSLATION_KNOWLEDGE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE';

/** Only operation directories under the host's root, with no redirected descendants. */
export function assertTranslationKnowledgeDirectory(
	directory: string,
	knowledgeRoot: string
): void {
	const root = path.resolve(knowledgeRoot);
	const resolved = path.resolve(directory);
	const parts = path.relative(root, resolved).split(path.sep);
	if (
		parts.length !== 2 ||
		!/^[a-f0-9]{64}$/.test(parts[0]) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[1])
	)
		throw new Error('Unsafe provider knowledge binding');
	for (const candidate of [path.dirname(resolved), resolved]) {
		try {
			if (fs.lstatSync(candidate).isSymbolicLink())
				throw new Error('Provider knowledge escapes its selected root through a symlink');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

/** Deliver on every continuation too; a resume may skip provider system-prompt flags. */
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined,
	knowledgeRoot: string
): string | undefined {
	if (!directory) return prompt;
	assertTranslationKnowledgeDirectory(directory, knowledgeRoot);
	const indexPath = path.join(directory, 'knowledge-index.md');
	if (fs.lstatSync(indexPath).isSymbolicLink())
		throw new Error('Unsafe provider knowledge index symlink');
	if (!prompt) return prompt;
	const index = fs.readFileSync(indexPath, 'utf8');
	if (!index.trim()) return prompt;
	const userPrompt = stripEmbeddedSystemPrompt(prompt);
	const existing = hasEmbeddedSystemPrompt(prompt)
		? prompt.slice(0, prompt.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR))
		: '';
	return embedSystemPromptInPrompt([existing, index].filter(Boolean).join('\n\n'), userPrompt);
}
