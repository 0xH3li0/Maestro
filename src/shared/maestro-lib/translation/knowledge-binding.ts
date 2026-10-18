import type { TranslationFs, TranslationFsStat } from './fs-port';
import { localTranslationFsSync } from './local-fs';
import * as path from 'node:path';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
	hasEmbeddedSystemPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
} from '../../embeddedSystemPrompt';

export const TRANSLATION_KNOWLEDGE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE';

/** Only operation directories under the host's root, with no redirected descendants. */
export function assertTranslationKnowledgeDirectory(directory: string, knowledgeRoot: string): void;
export function assertTranslationKnowledgeDirectory(
	directory: string,
	knowledgeRoot: string,
	nativeFs: TranslationFs
): Promise<void>;
export function assertTranslationKnowledgeDirectory(
	directory: string,
	knowledgeRoot: string,
	nativeFs?: TranslationFs
): void | Promise<void> {
	const paths = nativeFs?.paths ?? path;
	const root = paths.resolve(knowledgeRoot);
	const resolved = paths.resolve(directory);
	const parts = paths.relative(root, resolved).split(paths.sep);
	if (
		parts.length !== 2 ||
		!/^[a-f0-9]{64}$/.test(parts[0]) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[1])
	)
		throw new Error('Unsafe provider knowledge binding');
	const candidates = [paths.dirname(resolved), resolved];
	const check = (stat: TranslationFsStat): void => {
		if (stat.isSymbolicLink())
			throw new Error('Provider knowledge escapes its selected root through a symlink');
	};
	const allowMissing = (error: unknown): void => {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	};
	if (nativeFs)
		return Promise.all(
			candidates.map((candidate) => nativeFs.lstat(candidate).then(check, allowMissing))
		).then(() => {});
	for (const candidate of candidates) {
		try {
			check(localTranslationFsSync.lstat(candidate));
		} catch (error) {
			allowMissing(error);
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
	if (localTranslationFsSync.lstat(indexPath).isSymbolicLink())
		throw new Error('Unsafe provider knowledge index symlink');
	if (!prompt) return prompt;
	const index = localTranslationFsSync.readFile(indexPath);
	if (!index.trim()) return prompt;
	const userPrompt = stripEmbeddedSystemPrompt(prompt);
	const existing = hasEmbeddedSystemPrompt(prompt)
		? prompt.slice(0, prompt.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR))
		: '';
	return embedSystemPromptInPrompt([existing, index].filter(Boolean).join('\n\n'), userPrompt);
}
