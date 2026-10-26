import { describe, expect, it } from 'vitest';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import {
	SKETCH_NO_READ_ONLY_MODE_REASON,
	SKETCH_RESTRICTED_POSTURE_BLOCKERS,
	sketchRestrictedPostureBlocker,
} from '../../../shared/sketch/restricted-posture';

/** The provider's own `readOnlyArgs`, as the guardrail reads them. */
function blockerFor(toolType: string): string | null {
	return sketchRestrictedPostureBlocker(toolType, getAgentDefinition(toolType)?.readOnlyArgs);
}

describe('sketchRestrictedPostureBlocker', () => {
	it('blocks the providers whose read-only mode failed the live check (risk K1)', () => {
		expect(blockerFor('claude-code')).toBe(SKETCH_RESTRICTED_POSTURE_BLOCKERS['claude-code']);
		expect(blockerFor('claude-code')).toContain('plan mode');
		expect(blockerFor('opencode')).toBe(SKETCH_RESTRICTED_POSTURE_BLOCKERS.opencode);
		expect(blockerFor('opencode')).toContain('shell');
	});

	it('allows a verified provider whose read-only mode runs the sketch tools', () => {
		expect(blockerFor('codex')).toBeNull();
	});

	it('refuses a provider with no read-only mode', () => {
		expect(blockerFor('factory-droid')).toBe(SKETCH_NO_READ_ONLY_MODE_REASON);
		expect(sketchRestrictedPostureBlocker('codex', [])).toBe(SKETCH_NO_READ_ONLY_MODE_REASON);
		expect(sketchRestrictedPostureBlocker('codex', undefined)).toBe(
			SKETCH_NO_READ_ONLY_MODE_REASON
		);
	});

	it('names only providers that have a read-only mode to fail', () => {
		for (const toolType of Object.keys(SKETCH_RESTRICTED_POSTURE_BLOCKERS)) {
			expect(getAgentDefinition(toolType)?.readOnlyArgs?.length ?? 0).toBeGreaterThan(0);
		}
	});
});
