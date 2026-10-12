/**
 * @file hardware.test.ts
 *
 * The hardware probe behind the fit rule: unified memory on Apple Silicon (and
 * under Rosetta), GPU names and DxDiag memory from Electron's GPU info, and the
 * model server's device list filling in VRAM when Electron reports none.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getGPUInfo: vi.fn(),
		runningUnderARM64Translation: false,
		getPath: () => '/tmp/maestro-hardware-test',
	},
}));

import {
	acceleratorGpus,
	parseElectronGpuInfo,
	resolveHardwareProfile,
} from '../../../main/local-models/hardware';
import type { ServerAcceleratorReport } from '../../../shared/local-models/server-accelerator';

const GiB = 1024 ** 3;
const MiB = 1024 * 1024;

function report(devices: ServerAcceleratorReport['devices']): ServerAcceleratorReport {
	return {
		checkedAt: 1,
		status: 'gpu',
		label: 'Vulkan',
		devices,
		problem: null,
		detail: null,
		offerCpuBuild: false,
	};
}

const RTX_4060 = {
	id: 'Vulkan0',
	backend: 'vulkan' as const,
	name: 'NVIDIA GeForce RTX 4060',
	totalMiB: 8188,
	freeMiB: 7900,
	gpu: true,
};

const LLVMPIPE = {
	id: 'Vulkan1',
	backend: 'vulkan' as const,
	name: 'llvmpipe (LLVM 17.0.6, 256 bits)',
	totalMiB: 15_000,
	freeMiB: 15_000,
	gpu: false,
};

describe('parseElectronGpuInfo', () => {
	it('names each device from its description, or from its vendor', () => {
		const gpus = parseElectronGpuInfo({
			gpuDevice: [
				{
					vendorId: 0x10de,
					deviceId: 0x2882,
					deviceString: 'NVIDIA GeForce RTX 4060',
					active: true,
				},
				{ vendorId: 0x8086, deviceId: 0x4680 },
				{ vendorId: 0 },
			],
		});
		expect(gpus).toEqual([
			{ name: 'NVIDIA GeForce RTX 4060', vramBytes: null, source: 'electron' },
			{ name: 'Intel GPU 0x4680', vramBytes: null, source: 'electron' },
		]);
	});

	it('reads dedicated memory from the DxDiag tree when Electron has one', () => {
		const gpus = parseElectronGpuInfo({
			gpuDevice: [{ vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4060' }],
			dxDiagnostics: {
				children: {
					DxDiag_DisplayDevices: {
						children: {
							'0': {
								values: {
									szDescription: 'NVIDIA GeForce RTX 4060',
									szDedicatedMemoryEnglish: '8031 MB',
								},
							},
						},
					},
				},
			},
		});
		expect(gpus).toEqual([
			{ name: 'NVIDIA GeForce RTX 4060', vramBytes: 8031 * MiB, source: 'electron' },
		]);
	});

	it('tolerates any shape without throwing', () => {
		expect(parseElectronGpuInfo(null)).toEqual([]);
		expect(parseElectronGpuInfo('nope')).toEqual([]);
		expect(parseElectronGpuInfo({ gpuDevice: 'not a list' })).toEqual([]);
	});
});

describe('acceleratorGpus', () => {
	it('keeps GPU devices with their memory and drops software renderers', () => {
		expect(acceleratorGpus(report([RTX_4060, LLVMPIPE]))).toEqual([
			{ name: 'NVIDIA GeForce RTX 4060', vramBytes: 8188 * MiB, source: 'model-server' },
		]);
		expect(acceleratorGpus(null)).toEqual([]);
	});
});

describe('resolveHardwareProfile', () => {
	it('reports unified memory on Apple Silicon and does not read the device list', async () => {
		const readAccelerator = vi.fn();
		const profile = await resolveHardwareProfile({
			platform: 'darwin',
			arch: 'arm64',
			totalMemoryBytes: 128 * GiB,
			getGpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x106b, deviceString: 'Apple M5 Max' }] }),
			readAccelerator,
		});
		expect(profile).toEqual({
			platform: 'darwin',
			arch: 'arm64',
			totalMemoryBytes: 128 * GiB,
			unifiedMemory: true,
			gpus: [{ name: 'Apple M5 Max', vramBytes: null, source: 'electron' }],
		});
		expect(readAccelerator).not.toHaveBeenCalled();
	});

	it('treats an x64 build under Rosetta as unified memory', async () => {
		const profile = await resolveHardwareProfile({
			platform: 'darwin',
			arch: 'x64',
			runningUnderArm64Translation: true,
			totalMemoryBytes: 16 * GiB,
			getGpuInfo: async () => ({}),
		});
		expect(profile.unifiedMemory).toBe(true);
	});

	it('treats an Intel Mac as not unified', async () => {
		const profile = await resolveHardwareProfile({
			platform: 'darwin',
			arch: 'x64',
			runningUnderArm64Translation: false,
			totalMemoryBytes: 8 * GiB,
			getGpuInfo: async () => ({ gpuDevice: [{ vendorId: 0x8086, deviceString: 'Intel Iris' }] }),
			readAccelerator: async () => null,
		});
		expect(profile.unifiedMemory).toBe(false);
		expect(profile.gpus).toEqual([{ name: 'Intel Iris', vramBytes: null, source: 'electron' }]);
	});

	it('fills in VRAM from the model server on Windows and Linux, keeping devices it did not see', async () => {
		const profile = await resolveHardwareProfile({
			platform: 'win32',
			arch: 'x64',
			totalMemoryBytes: 32 * GiB,
			getGpuInfo: async () => ({
				gpuDevice: [
					{ vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4060' },
					{ vendorId: 0x8086, deviceString: 'Intel(R) UHD Graphics 770' },
				],
			}),
			readAccelerator: async () => report([RTX_4060]),
		});
		expect(profile.gpus).toEqual([
			{ name: 'NVIDIA GeForce RTX 4060', vramBytes: 8188 * MiB, source: 'model-server' },
			{ name: 'Intel(R) UHD Graphics 770', vramBytes: null, source: 'electron' },
		]);
	});

	it('keeps Electron VRAM when it has some, without reading the device list', async () => {
		const readAccelerator = vi.fn();
		const profile = await resolveHardwareProfile({
			platform: 'win32',
			arch: 'x64',
			totalMemoryBytes: 32 * GiB,
			getGpuInfo: async () => ({
				dxDiagnostics: {
					values: { szDescription: 'AMD Radeon RX 7800 XT', szDedicatedMemoryEnglish: '16368 MB' },
				},
			}),
			readAccelerator,
		});
		expect(profile.gpus).toEqual([
			{ name: 'AMD Radeon RX 7800 XT', vramBytes: 16368 * MiB, source: 'electron' },
		]);
		expect(readAccelerator).not.toHaveBeenCalled();
	});

	it('reports no GPU memory at all when no engine is installed (CPU-only rule)', async () => {
		const profile = await resolveHardwareProfile({
			platform: 'linux',
			arch: 'x64',
			totalMemoryBytes: 16 * GiB,
			getGpuInfo: async () => null,
			readAccelerator: async () => null,
		});
		expect(profile.gpus).toEqual([]);
		expect(profile.unifiedMemory).toBe(false);
	});

	it('falls back to an empty device list when Electron rejects (GPU disabled)', async () => {
		const { app } = await import('electron');
		vi.mocked(app.getGPUInfo).mockRejectedValueOnce(new Error('GPU access is disabled'));
		const profile = await resolveHardwareProfile({
			platform: 'linux',
			arch: 'x64',
			totalMemoryBytes: 16 * GiB,
			readAccelerator: async () => null,
		});
		expect(profile.gpus).toEqual([]);
	});
});
