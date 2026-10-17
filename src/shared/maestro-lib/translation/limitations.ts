import type { TranslationLimitation } from './types';

/** Only warnings need consent; info is advisory and blocks cannot be accepted. */
export function limitationsNeedingAcceptance(
	limitations: readonly TranslationLimitation[]
): TranslationLimitation[] {
	return limitations.filter((limitation) => limitation.severity === 'warning');
}
