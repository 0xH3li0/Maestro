/**
 * @file runtime-selftest.test.ts
 *
 * The self-test is what a support report carries instead of "the local model
 * does not work". So the things worth asserting are the ones that would make that report
 * misleading: a runtime that is not part of the build reading as broken, a
 * failure taking the whole diagnostic down with it, or a hung load turning the
 * diagnostic into a second copy of the bug being diagnosed.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/local-models-selftest-test' },
}));

import {
	runRuntimeSelfTest,
	formatRuntimeSelfTestLines,
} from '../../../../main/local-models/runtime/runtime-selftest';
import type { NativeRuntimeResult } from '../../../../main/local-models/runtime/native-loader';
import {
	selfTestVerdict,
	type NativeRuntimeId,
} from '../../../../shared/local-models/native-runtimes';

/** Module surfaces the real probes accept. */
const WORKING_MODULES: Record<NativeRuntimeId, unknown> = {
	llama: { getLlama: () => undefined },
	onnx: { InferenceSession: {}, env: { versions: { common: '1.27.0' } } },
};

function loader(
	behaviour: Partial<
		Record<NativeRuntimeId, 'pass' | 'fail' | 'skip' | 'missing' | 'bad-surface' | 'hang'>
	>
) {
	return async (id: NativeRuntimeId): Promise<NativeRuntimeResult<unknown>> => {
		const mode = behaviour[id] ?? 'pass';
		if (mode === 'hang') return new Promise(() => undefined);
		if (mode === 'bad-surface') return { ok: true, module: {} };
		if (mode === 'pass') return { ok: true, module: WORKING_MODULES[id] };
		return {
			ok: false,
			error: {
				kind: 'runtime-unavailable',
				runtimeId: id,
				moduleId: `mock-${id}`,
				platform: 'darwin',
				arch: 'arm64',
				failure:
					mode === 'skip'
						? 'not-a-dependency'
						: mode === 'missing'
							? 'not-downloaded'
							: 'load-failed',
				message:
					mode === 'skip'
						? 'not part of this build yet'
						: mode === 'missing'
							? 'not downloaded yet'
							: 'dlopen failed',
				suggestedAction: 'do the thing',
				detail: mode === 'skip' || mode === 'missing' ? undefined : 'symbol not found',
			},
		};
	};
}

describe('runtime-selftest', () => {
	it('reports every registered runtime, in registry order', async () => {
		const report = await runRuntimeSelfTest({ loadRuntime: loader({}) });

		expect(report.entries.map((entry) => entry.runtimeId)).toEqual(['llama', 'onnx']);
		expect(report.entries.every((entry) => entry.status === 'pass')).toBe(true);
		expect(report.passed).toBe(true);
	});

	it('reports a per-runtime failure without failing the others', async () => {
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ onnx: 'fail' }),
		});

		const onnx = report.entries.find((entry) => entry.runtimeId === 'onnx')!;
		expect(onnx.status).toBe('fail');
		expect(onnx.failure).toBe('load-failed');
		// The underlying cause travels: a support report with "it failed" in it is
		// the same as no support report.
		expect(onnx.detail).toContain('symbol not found');

		expect(report.entries.find((entry) => entry.runtimeId === 'llama')?.status).toBe('pass');
		expect(report.passed).toBe(false);
	});

	it('skips a runtime that is not part of the build rather than calling it broken', async () => {
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ onnx: 'skip' }),
		});

		expect(report.entries.find((entry) => entry.runtimeId === 'onnx')?.status).toBe('skipped');
		// A skip is not a failure. Reporting it as one would send someone hunting a
		// bug that does not exist.
		expect(report.passed).toBe(true);
	});

	it('marks a fetchable runtime that was never downloaded as missing, and says the run is incomplete', async () => {
		// The report a user pasted: ONNX never downloaded, filed as "skipped", run
		// "passed" - while every local model on it was dead.
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ onnx: 'missing' }),
		});

		const onnx = report.entries.find((entry) => entry.runtimeId === 'onnx')!;
		expect(onnx.status).toBe('missing');
		expect(onnx.failure).toBe('not-downloaded');
		// Nothing is broken, so it does not FAIL...
		expect(report.passed).toBe(true);
		// ...but it is not a pass either.
		expect(selfTestVerdict(report)).toBe('INCOMPLETE');
		expect(formatRuntimeSelfTestLines(report, 'Self-test')[0]).toContain('INCOMPLETE');
	});

	it('calls a run with every runtime loaded a pass', async () => {
		const report = await runRuntimeSelfTest({ loadRuntime: loader({}) });
		expect(selfTestVerdict(report)).toBe('PASS');
	});

	it('fails a runtime that loads but has lost the API the provider calls', async () => {
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ onnx: 'bad-surface' }),
		});

		const onnx = report.entries.find((entry) => entry.runtimeId === 'onnx')!;
		expect(onnx.status).toBe('fail');
		expect(onnx.failure).toBe('probe-failed');
		expect(onnx.detail).toContain('InferenceSession');
	});

	it('reports the probe detail on success, so a version reaches the report', async () => {
		const report = await runRuntimeSelfTest({ loadRuntime: loader({}) });
		expect(report.entries.find((entry) => entry.runtimeId === 'onnx')?.detail).toContain('1.27.0');
	});

	it('times out instead of hanging, which is the bug it is diagnosing', async () => {
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ llama: 'hang' }),
			timeoutMs: 20,
		});

		const llama = report.entries.find((entry) => entry.runtimeId === 'llama')!;
		expect(llama.status).toBe('fail');
		expect(llama.failure).toBe('timeout');
	});

	it('records timings from the injected clock', async () => {
		let clock = 1000;
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({}),
			now: () => (clock += 5),
		});

		expect(report.entries.every((entry) => entry.durationMs > 0)).toBe(true);
		expect(report.ranAt).toBeGreaterThan(1000);
	});

	it('formats a report that names each runtime and its verdict', async () => {
		const report = await runRuntimeSelfTest({
			loadRuntime: loader({ onnx: 'fail' }),
		});

		const text = formatRuntimeSelfTestLines(report, 'Local Models self-test').join('\n');
		expect(text).toContain('Local Models self-test on');
		expect(text).toContain('FAIL');
		expect(text).toContain('PASS');
		expect(text).toContain('node-llama-cpp');
	});
});
