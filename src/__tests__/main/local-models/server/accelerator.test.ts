/**
 * @file accelerator.test.ts
 *
 * The device check that runs `llama-server --list-devices`: it never throws, it
 * hands the run to the shared classifier, and the recheck stores the new answer
 * in the engine manifest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
	checkServerAccelerator,
	recheckServerAccelerator,
} from '../../../../main/local-models/server/accelerator';
import {
	readServerEngineManifest,
	serverEngineDir,
	writeServerEngineManifest,
	type ServerEngineManifest,
} from '../../../../main/local-models/server/engine-store';

const METAL = 'Available devices:\n  MTL0: Apple M5 Max (110100 MiB, 110099 MiB free)\n';
const NONE = 'Available devices:\n  (none)\n';

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'accelerator-userdata-'));
	process.env.MAESTRO_USER_DATA = tempRoot;
});

afterEach(async () => {
	delete process.env.MAESTRO_USER_DATA;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function installFakeEngine(over: Partial<ServerEngineManifest> = {}): Promise<string> {
	const binary = path.join(serverEngineDir(), 'llama-server');
	await fs.mkdir(serverEngineDir(), { recursive: true });
	await fs.writeFile(binary, '#!/bin/sh\n');
	await writeServerEngineManifest({
		release: 'b11559',
		platform: 'linux-x64',
		choice: 'default',
		kind: 'vulkan',
		label: 'Vulkan',
		assets: [],
		binary: 'llama-server',
		installedAt: 1,
		bytes: 1,
		...over,
	});
	return binary;
}

describe('checkServerAccelerator', () => {
	it('runs the binary it was given and classifies the output', async () => {
		const runListDevices = vi.fn(async () => ({ stdout: METAL, stderr: '', exitCode: 0 }));
		const report = await checkServerAccelerator('/opt/My Apps/llama-server', 'metal', {
			runListDevices,
			platform: 'darwin',
			arch: 'arm64',
		});
		expect(runListDevices).toHaveBeenCalledWith('/opt/My Apps/llama-server');
		expect(report).toMatchObject({ status: 'gpu', label: 'Metal (Apple M5 Max)' });
	});

	it('turns a runner that throws into a failed report instead of throwing', async () => {
		const report = await checkServerAccelerator('/missing', 'vulkan', {
			runListDevices: async () => {
				throw new Error('spawn ENOENT');
			},
			platform: 'win32',
			arch: 'x64',
		});
		expect(report).toMatchObject({
			status: 'failed',
			problem: 'failed-to-run',
			detail: 'spawn ENOENT',
			offerCpuBuild: true,
		});
	});
});

describe('recheckServerAccelerator', () => {
	it('returns null when no engine is installed', async () => {
		expect(await recheckServerAccelerator({ runListDevices: vi.fn() })).toBeNull();
	});

	it('stores the new answer in the manifest and keeps the rest of it', async () => {
		const binary = await installFakeEngine();
		const runListDevices = vi.fn(async () => ({ stdout: NONE, stderr: '', exitCode: 0 }));

		const report = await recheckServerAccelerator({
			runListDevices,
			platform: 'linux',
			arch: 'x64',
		});

		expect(runListDevices).toHaveBeenCalledWith(binary);
		expect(report).toMatchObject({ status: 'cpu', problem: 'no-gpu-device', offerCpuBuild: true });
		const manifest = await readServerEngineManifest();
		expect(manifest).toMatchObject({ kind: 'vulkan', installedAt: 1 });
		expect(manifest?.accelerator).toEqual(report);
	});
});
