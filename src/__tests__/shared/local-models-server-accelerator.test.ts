/**
 * @file local-models-server-accelerator.test.ts
 *
 * Parsing `llama-server --list-devices` and classifying the run.
 *
 * `MACOS_ARM64_METAL` was captured from the pinned `b11559` macOS arm64 build on
 * an M5 Max. The other fixtures follow the exact formats in that release's source:
 * `common_print_available_devices()` in `common/arg.cpp` for stdout (including the
 * `  (none)` line) and `load_backend: failed to load <path>: <reason>` in
 * `ggml/src/ggml-backend-reg.cpp` for stderr. Device descriptions are what each
 * vendor's driver reports.
 */

import { describe, it, expect } from 'vitest';

import {
	acceleratorLabel,
	classifyAcceleratorProbe,
	parseListDevices,
	serverAcceleratorProblemMessage,
	type ListDevicesRun,
} from '../../shared/local-models/server-accelerator';
import type { ServerBuildKind } from '../../shared/local-models/server-engine';

const MACOS_ARM64_METAL = [
	'Available devices:',
	'  MTL0: Apple M5 Max (110100 MiB, 110099 MiB free)',
	'  BLAS: Accelerate (0 MiB, 0 MiB free)',
	'',
].join('\n');

const WINDOWS_VULKAN_NVIDIA = [
	'Available devices:',
	'  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23012 MiB free)',
	'',
].join('\r\n');

const LINUX_VULKAN_TWO_GPUS = [
	'Available devices:',
	'  Vulkan0: AMD Radeon RX 7900 XTX (RADV NAVI31) (24560 MiB, 24000 MiB free)',
	'  Vulkan1: Intel(R) UHD Graphics 770 (ADL-S GT1) (15800 MiB, 15800 MiB free)',
	'',
].join('\n');

const LINUX_VULKAN_LLVMPIPE = [
	'Available devices:',
	'  Vulkan0: llvmpipe (LLVM 15.0.7, 256 bits) (31998 MiB, 31998 MiB free)',
	'',
].join('\n');

const LINUX_CUDA = [
	'Available devices:',
	'  CUDA0: NVIDIA GeForce RTX 3090 (24135 MiB, 23700 MiB free)',
	'  CUDA1: NVIDIA GeForce RTX 3090 (24135 MiB, 23900 MiB free)',
	'',
].join('\n');

const LINUX_ROCM = [
	'Available devices:',
	'  ROCm0: AMD Radeon RX 7900 XTX (24560 MiB, 24400 MiB free)',
	'',
].join('\n');

const NONE = 'Available devices:\n  (none)\n';

const WINDOWS_VULKAN_LOADER_MISSING_STDERR =
	'load_backend: failed to load C:\\Users\\Pat Doe\\AppData\\Roaming\\Maestro\\runtimes\\llama-server\\ggml-vulkan.dll: The specified module could not be found.\r\n' +
	'load_backend: loaded CPU backend from C:\\Users\\Pat Doe\\AppData\\Roaming\\Maestro\\runtimes\\llama-server\\ggml-cpu-haswell.dll\r\n';

const LINUX_VULKAN_LOADER_MISSING_STDERR =
	'load_backend: failed to load /home/pat/.config/Maestro/runtimes/llama-server/libggml-vulkan.so: libvulkan.so.1: cannot open shared object file: No such file or directory\n' +
	'load_backend: loaded CPU backend from /home/pat/.config/Maestro/runtimes/llama-server/libggml-cpu-haswell.so\n';

function ok(stdout: string, stderr = ''): ListDevicesRun {
	return { stdout, stderr, exitCode: 0 };
}

function classify(kind: ServerBuildKind, platform: string, arch: string, run: ListDevicesRun) {
	return classifyAcceleratorProbe({ kind, platform, arch, run, now: 1 });
}

describe('parseListDevices', () => {
	it('parses the captured macOS output and does not count BLAS as a GPU', () => {
		expect(parseListDevices(MACOS_ARM64_METAL)).toEqual([
			{
				id: 'MTL0',
				backend: 'metal',
				name: 'Apple M5 Max',
				totalMiB: 110100,
				freeMiB: 110099,
				gpu: true,
			},
			{ id: 'BLAS', backend: 'blas', name: 'Accelerate', totalMiB: 0, freeMiB: 0, gpu: false },
		]);
	});

	it('handles CRLF line endings', () => {
		expect(parseListDevices(WINDOWS_VULKAN_NVIDIA)).toEqual([
			expect.objectContaining({
				id: 'Vulkan0',
				backend: 'vulkan',
				name: 'NVIDIA GeForce RTX 4090',
			}),
		]);
	});

	it('keeps parentheses that belong to the description', () => {
		const [amd, intel] = parseListDevices(LINUX_VULKAN_TWO_GPUS);
		expect(amd).toMatchObject({ name: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMiB: 24560 });
		expect(intel).toMatchObject({ name: 'Intel(R) UHD Graphics 770 (ADL-S GT1)', gpu: true });
	});

	it('marks a software Vulkan renderer as not a GPU', () => {
		expect(parseListDevices(LINUX_VULKAN_LLVMPIPE)).toEqual([
			expect.objectContaining({
				backend: 'vulkan',
				name: 'llvmpipe (LLVM 15.0.7, 256 bits)',
				gpu: false,
			}),
		]);
	});

	it('names CUDA and ROCm devices', () => {
		expect(parseListDevices(LINUX_CUDA).map((device) => device.backend)).toEqual(['cuda', 'cuda']);
		expect(parseListDevices(LINUX_ROCM)[0]).toMatchObject({ backend: 'rocm', gpu: true });
	});

	it('returns nothing for "(none)", empty output and log noise', () => {
		expect(parseListDevices(NONE)).toEqual([]);
		expect(parseListDevices('')).toEqual([]);
		expect(parseListDevices('ggml_metal_init: allocating\nsome: line without memory\n')).toEqual(
			[]
		);
	});

	it('files an unknown backend under other, not GPU', () => {
		expect(parseListDevices('  RPC0: 10.0.0.2:50052 (8000 MiB, 8000 MiB free)\n')[0]).toMatchObject(
			{
				backend: 'other',
				gpu: false,
			}
		);
	});
});

describe('acceleratorLabel', () => {
	it('names the backend and the device', () => {
		const [metal] = parseListDevices(MACOS_ARM64_METAL);
		expect(acceleratorLabel(metal)).toBe('Metal (Apple M5 Max)');
	});
});

describe('classifyAcceleratorProbe', () => {
	it('reports Metal on Apple silicon', () => {
		expect(classify('metal', 'darwin', 'arm64', ok(MACOS_ARM64_METAL))).toMatchObject({
			checkedAt: 1,
			status: 'gpu',
			label: 'Metal (Apple M5 Max)',
			problem: null,
			offerCpuBuild: false,
		});
	});

	it('reports the first GPU of a Vulkan build', () => {
		expect(classify('vulkan', 'win32', 'x64', ok(WINDOWS_VULKAN_NVIDIA)).label).toBe(
			'Vulkan (NVIDIA GeForce RTX 4090)'
		);
		expect(classify('vulkan', 'linux', 'x64', ok(LINUX_VULKAN_TWO_GPUS)).label).toBe(
			'Vulkan (AMD Radeon RX 7900 XTX (RADV NAVI31))'
		);
	});

	it('reports CUDA and ROCm builds by their device', () => {
		expect(classify('cuda', 'linux', 'x64', ok(LINUX_CUDA)).label).toBe(
			'CUDA (NVIDIA GeForce RTX 3090)'
		);
		expect(classify('rocm', 'linux', 'x64', ok(LINUX_ROCM)).label).toBe(
			'ROCm (AMD Radeon RX 7900 XTX)'
		);
	});

	it('reports a CPU build as CPU with no problem', () => {
		for (const [platform, arch] of [
			['darwin', 'x64'],
			['win32', 'x64'],
			['linux', 'arm64'],
		]) {
			expect(classify('cpu', platform, arch, ok(NONE))).toMatchObject({
				status: 'cpu',
				label: 'CPU',
				problem: null,
				offerCpuBuild: false,
			});
		}
	});

	it('flags a Vulkan build with no GPU and offers the CPU build on Windows and Linux', () => {
		for (const [platform, arch] of [
			['win32', 'x64'],
			['win32', 'arm64'],
			['linux', 'x64'],
			['linux', 'arm64'],
		]) {
			expect(classify('vulkan', platform, arch, ok(NONE))).toMatchObject({
				status: 'cpu',
				label: 'CPU',
				problem: 'no-gpu-device',
				offerCpuBuild: true,
			});
		}
	});

	it('treats llvmpipe as no GPU', () => {
		const report = classify('vulkan', 'linux', 'x64', ok(LINUX_VULKAN_LLVMPIPE));
		expect(report).toMatchObject({ status: 'cpu', problem: 'no-gpu-device', offerCpuBuild: true });
		expect(serverAcceleratorProblemMessage(report)).toContain('software renderer (llvmpipe');
	});

	it('names a missing Vulkan loader when the backend fails to load but the server still runs', () => {
		for (const [platform, stderr] of [
			['win32', WINDOWS_VULKAN_LOADER_MISSING_STDERR],
			['linux', LINUX_VULKAN_LOADER_MISSING_STDERR],
		]) {
			const report = classify('vulkan', platform, 'x64', ok(NONE, stderr));
			expect(report).toMatchObject({
				status: 'cpu',
				problem: 'vulkan-loader-missing',
				offerCpuBuild: true,
			});
			expect(report.detail).toContain('failed to load');
		}
	});

	it('names a missing Vulkan loader when the process cannot start', () => {
		const linux = classify('vulkan', 'linux', 'x64', {
			stdout: '',
			stderr:
				'llama-server: error while loading shared libraries: libvulkan.so.1: cannot open shared object file: No such file or directory\n',
			exitCode: 127,
		});
		expect(linux).toMatchObject({
			status: 'failed',
			problem: 'vulkan-loader-missing',
			offerCpuBuild: true,
		});

		for (const exitCode of [3221225781, -1073741515]) {
			expect(
				classify('vulkan', 'win32', 'x64', { stdout: '', stderr: '', exitCode })
			).toMatchObject({
				status: 'failed',
				problem: 'vulkan-loader-missing',
				detail: `Exit code ${exitCode}`,
			});
		}
	});

	it('reports any other failure as failed-to-run', () => {
		const report = classify('vulkan', 'win32', 'x64', {
			stdout: '',
			stderr: 'spawn EACCES',
			exitCode: 'EACCES',
		});
		expect(report).toMatchObject({
			status: 'failed',
			label: 'Unavailable',
			problem: 'failed-to-run',
			detail: 'spawn EACCES',
			offerCpuBuild: true,
		});
		expect(
			classify('cpu', 'linux', 'x64', { stdout: '', stderr: '', exitCode: 1 }).offerCpuBuild
		).toBe(false);
	});

	it('never offers a CPU build where none exists (Apple silicon is Metal only)', () => {
		const report = classify('metal', 'darwin', 'arm64', ok(NONE));
		expect(report).toMatchObject({ status: 'cpu', problem: 'no-gpu-device', offerCpuBuild: false });
		expect(serverAcceleratorProblemMessage(report)).not.toContain('CPU build');
	});

	it('keeps only the last stderr lines as detail', () => {
		const stderr = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
		const report = classify('vulkan', 'linux', 'x64', { stdout: '', stderr, exitCode: 1 });
		expect(report.detail?.split('\n')).toEqual([
			'line 14',
			'line 15',
			'line 16',
			'line 17',
			'line 18',
			'line 19',
		]);
	});
});

describe('serverAcceleratorProblemMessage', () => {
	it('is null when nothing is wrong', () => {
		expect(
			serverAcceleratorProblemMessage(classify('metal', 'darwin', 'arm64', ok(MACOS_ARM64_METAL)))
		).toBeNull();
	});

	it('names the loader and the CPU build offer', () => {
		const message = serverAcceleratorProblemMessage(
			classify('vulkan', 'win32', 'x64', ok(NONE, WINDOWS_VULKAN_LOADER_MISSING_STDERR))
		);
		expect(message).toContain('Vulkan loader is missing');
		expect(message).toContain('install the CPU build instead');
	});
});
