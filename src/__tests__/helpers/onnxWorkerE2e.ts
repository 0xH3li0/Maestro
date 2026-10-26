/**
 * The real ONNX worker for Local Models E2E tests that run a model from source.
 *
 * `OnnxWorkerSession` starts `onnx-worker.js` beside its own module, a file
 * only the build produces. Under vitest that module is the TypeScript source,
 * so the worker is missing and every encoder fails to open. This bundles the
 * worker entry with esbuild once and points the worker there, so an E2E test
 * still runs the real worker and its transport:
 *
 *   vi.mock('worker_threads', async (importOriginal) =>
 *     (await import('../../helpers/onnxWorkerE2e')).workerThreadsWithBuiltOnnxWorker(
 *       await importOriginal<typeof import('worker_threads')>()
 *     )
 *   );
 *
 * Any other worker file starts unchanged.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import type * as WorkerThreads from 'worker_threads';

const WORKER_SOURCE = path.resolve(__dirname, '../../main/local-models/runtime/onnx-worker.ts');
const BUILT_WORKER_NAME = 'onnx-worker.js';

let builtWorker: string | null = null;

/** Bundle the worker entry once per test file. */
function buildOnnxWorker(): string {
	if (builtWorker) return builtWorker;
	const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'maestro-onnx-worker-e2e-')), 'w.cjs');
	buildSync({
		entryPoints: [WORKER_SOURCE],
		outfile,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['electron'],
	});
	builtWorker = outfile;
	return outfile;
}

/** `worker_threads` with `Worker` sending the ONNX worker to the bundled entry. */
export function workerThreadsWithBuiltOnnxWorker(
	actual: typeof WorkerThreads
): typeof WorkerThreads {
	class RedirectingWorker extends actual.Worker {
		constructor(filename: string | URL, options?: WorkerThreads.WorkerOptions) {
			const target =
				typeof filename === 'string' && path.basename(filename) === BUILT_WORKER_NAME
					? buildOnnxWorker()
					: filename;
			super(target, options);
		}
	}
	const mocked = { ...actual, Worker: RedirectingWorker };
	// A default import must see the same Worker as a named one.
	return { ...mocked, default: mocked } as typeof WorkerThreads;
}
