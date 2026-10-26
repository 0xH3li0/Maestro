import { describe, expect, it } from 'vitest';
import { createSlidingWindowGuard } from '../../../main/utils/sliding-window-guard';

const limits = { windowMs: 1000, maxPerWindow: 2, maxConcurrent: 1 };

describe('createSlidingWindowGuard', () => {
	it('admits up to the window limit, then refuses until the window slides', () => {
		let t = 0;
		const guard = createSlidingWindowGuard(() => t);
		const first = guard.begin('k', limits);
		expect(first.ok).toBe(true);
		if (first.ok) first.release();
		const second = guard.begin('k', limits);
		if (second.ok) second.release();

		expect(guard.begin('k', limits)).toEqual({ ok: false, limit: 'rate', count: 2 });
		t = 1000;
		expect(guard.begin('k', limits).ok).toBe(true);
	});

	it('caps the actions in flight and frees a slot on release, once', () => {
		const guard = createSlidingWindowGuard(() => 0);
		const roomy = { ...limits, maxPerWindow: 10 };
		const first = guard.begin('k', roomy);
		expect(guard.begin('k', roomy)).toEqual({ ok: false, limit: 'concurrency', count: 1 });
		if (!first.ok) throw new Error('expected admission');
		first.release();
		first.release();
		const second = guard.begin('k', roomy);
		expect(second.ok).toBe(true);
		expect(guard.begin('k', roomy).ok).toBe(false);
	});

	it('keeps keys apart, and a refusal counts toward nothing', () => {
		const guard = createSlidingWindowGuard(() => 0);
		const one = { ...limits, maxPerWindow: 1, maxConcurrent: 5 };
		expect(guard.begin('a', one).ok).toBe(true);
		expect(guard.begin('a', one).ok).toBe(false);
		expect(guard.begin('a', one)).toEqual({ ok: false, limit: 'rate', count: 1 });
		expect(guard.begin('b', one).ok).toBe(true);
	});
});
