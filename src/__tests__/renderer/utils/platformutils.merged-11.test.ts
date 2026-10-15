// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/utils/platformUtils.test.ts
//   - src/__tests__/renderer/utils/remarkFileLinks.test.ts
//   - src/__tests__/renderer/utils/shortcutRecorder.test.ts
//   - src/__tests__/renderer/utils/sidebarMembership.test.ts
//   - src/__tests__/renderer/utils/splitOnMatches.test.ts

import type { Session } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';
import { splitOnMatches } from '../../../renderer/utils/highlightMatches';
import {
	fileManagerName,
	getFileManagerName,
	getOpenInLabel,
	getRevealLabel,
	isLinuxPlatform,
	isMacOSKeyboard,
	isMacOSPlatform,
	isWindowsPlatform,
} from '../../../renderer/utils/platformUtils';
import { buildFileTreeIndices, remarkFileLinks } from '../../../renderer/utils/remarkFileLinks';
import { buildEventFromKeys, buildKeysFromEvent } from '../../../renderer/utils/shortcutRecorder';
import {
	passesUnreadFilter,
	sessionMatchesFilter,
} from '../../../renderer/utils/sidebarMembership';
import { createMockSession } from '../../helpers/mockSession';
import type React from 'react';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===== from src/__tests__/renderer/utils/platformUtils.test.ts =====

describe('platformUtils', () => {
	const originalConfig = window.__MAESTRO_CONFIG__;
	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
		window.__MAESTRO_CONFIG__ = originalConfig;
		vi.restoreAllMocks();
	});

	it('keeps physical keyboard conventions independent of remote execution OS', () => {
		window.__MAESTRO_CONFIG__ = {
			securityToken: 'test',
			sessionId: null,
			tabId: null,
			apiBase: '/test/api',
			wsUrl: '/test/ws',
			hostPlatform: 'win32',
		};
		(window as any).maestro = { platform: 'win32' };
		const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
		expect(isWindowsPlatform()).toBe(true);
		expect(isMacOSKeyboard()).toBe(true);
		(window as any).maestro = { platform: 'darwin' };
		platform.mockReturnValue('Win32');
		expect(isMacOSPlatform()).toBe(true);
		expect(isMacOSKeyboard()).toBe(false);
	});

	describe('isWindowsPlatform', () => {
		it('returns true for win32', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(isWindowsPlatform()).toBe(true);
		});

		it('returns false for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isWindowsPlatform()).toBe(false);
		});

		it('returns false when maestro is undefined', () => {
			(window as any).maestro = undefined;
			expect(isWindowsPlatform()).toBe(false);
		});
	});

	describe('isMacOSPlatform', () => {
		it('returns true for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isMacOSPlatform()).toBe(true);
		});

		it('returns false for win32', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(isMacOSPlatform()).toBe(false);
		});

		it('returns false for linux', () => {
			(window as any).maestro = { platform: 'linux' };
			expect(isMacOSPlatform()).toBe(false);
		});
	});

	describe('isLinuxPlatform', () => {
		it('returns true for linux', () => {
			(window as any).maestro = { platform: 'linux' };
			expect(isLinuxPlatform()).toBe(true);
		});

		it('returns false for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isLinuxPlatform()).toBe(false);
		});
	});

	describe('getFileManagerName', () => {
		it('names the file manager per platform', () => {
			expect(getFileManagerName('darwin')).toBe('Finder');
			expect(getFileManagerName('win32')).toBe('Explorer');
			expect(getFileManagerName('linux')).toBe('File Manager');
		});

		it('falls back to Finder for unknown platforms', () => {
			expect(getFileManagerName('freebsd')).toBe('Finder');
			expect(getFileManagerName('')).toBe('Finder');
		});
	});

	describe('fileManagerName', () => {
		it('resolves the platform from the preload bridge', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(fileManagerName()).toBe('Explorer');
			(window as any).maestro = { platform: 'darwin' };
			expect(fileManagerName()).toBe('Finder');
		});

		it('falls back to Finder when the bridge is missing', () => {
			(window as any).maestro = undefined;
			expect(fileManagerName()).toBe('Finder');
		});
	});

	describe('getRevealLabel', () => {
		it('returns "Reveal in Finder" for darwin', () => {
			expect(getRevealLabel('darwin')).toBe('Reveal in Finder');
		});

		it('returns "Reveal in Explorer" for win32', () => {
			expect(getRevealLabel('win32')).toBe('Reveal in Explorer');
		});

		it('returns "Reveal in File Manager" for linux', () => {
			expect(getRevealLabel('linux')).toBe('Reveal in File Manager');
		});

		it('returns "Reveal in Finder" for unknown platforms', () => {
			expect(getRevealLabel('freebsd')).toBe('Reveal in Finder');
			expect(getRevealLabel('')).toBe('Reveal in Finder');
		});
	});

	describe('getOpenInLabel', () => {
		it('returns "Open in Finder" for darwin', () => {
			expect(getOpenInLabel('darwin')).toBe('Open in Finder');
		});

		it('returns "Open in Explorer" for win32', () => {
			expect(getOpenInLabel('win32')).toBe('Open in Explorer');
		});

		it('returns "Open in File Manager" for linux', () => {
			expect(getOpenInLabel('linux')).toBe('Open in File Manager');
		});

		it('returns "Open in Finder" for unknown platforms', () => {
			expect(getOpenInLabel('freebsd')).toBe('Open in Finder');
			expect(getOpenInLabel('')).toBe('Open in Finder');
		});
	});
});

// ===== from src/__tests__/renderer/utils/remarkFileLinks.test.ts =====

// Helper to process markdown and return the result
async function processMarkdown(
	content: string,
	fileTree: FileNode[],
	cwd: string,
	projectRoot?: string,
	homeDir?: string
): Promise<string> {
	const result = await unified()
		.use(remarkParse)
		.use(remarkFileLinks, { fileTree, cwd, projectRoot, homeDir })
		.use(remarkStringify)
		.process(content);
	return String(result);
}

// Sample file tree for testing
const sampleFileTree: FileNode[] = [
	{
		name: 'OPSWAT',
		type: 'folder',
		children: [
			{
				name: 'Meetings',
				type: 'folder',
				children: [
					{ name: 'OP-0088.md', type: 'file' },
					{ name: 'OP-0200.md', type: 'file' },
				],
			},
			{ name: 'README.md', type: 'file' },
		],
	},
	{
		name: 'Notes',
		type: 'folder',
		children: [
			{ name: 'Meeting Notes.md', type: 'file' },
			{ name: 'TODO.md', type: 'file' },
		],
	},
	{
		name: 'Archive',
		type: 'folder',
		children: [
			{ name: 'Meeting Notes.md', type: 'file' }, // Duplicate filename
		],
	},
	{
		name: 'attachments',
		type: 'folder',
		children: [
			{ name: 'Pasted image 20250519123910.png', type: 'file' },
			{ name: 'screenshot.jpg', type: 'file' },
		],
	},
	{
		name: 'output',
		type: 'folder',
		children: [
			{ name: 'recording.wav', type: 'file' },
			{ name: 'report.pdf', type: 'file' },
			{ name: 'data.csv', type: 'file' },
		],
	},
	{ name: 'README.md', type: 'file' },
	{ name: 'config.json', type: 'file' },
	{ name: 'index.ts', type: 'file' },
];

describe('remarkFileLinks', () => {
	describe('path-style references', () => {
		it('converts valid path with slash to link', async () => {
			const result = await processMarkdown(
				'See OPSWAT/Meetings/OP-0088 for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('converts path with .md extension', async () => {
			const result = await processMarkdown('Check OPSWAT/README.md for info.', sampleFileTree, '');
			expect(result).toContain('[OPSWAT/README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts single file reference with extension', async () => {
			const result = await processMarkdown('See README.md for details.', sampleFileTree, '');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('converts file references with various extensions', async () => {
			const result = await processMarkdown('Check config.json and index.ts', sampleFileTree, '');
			expect(result).toContain('[config.json](maestro-file://config.json)');
			expect(result).toContain('[index.ts](maestro-file://index.ts)');
		});

		it('does not convert non-existent paths', async () => {
			const result = await processMarkdown(
				'See NonExistent/Path/File for details.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('NonExistent/Path/File');
		});

		it('does not convert URLs', async () => {
			const result = await processMarkdown(
				'Visit https://example.com/path/file for more.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
		});

		it('handles multiple path references in same text', async () => {
			const result = await processMarkdown(
				'See OPSWAT/Meetings/OP-0088 and OPSWAT/Meetings/OP-0200 for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0200](maestro-file://OPSWAT/Meetings/OP-0200.md)'
			);
		});
	});

	describe('wiki-style references', () => {
		it('converts wiki link to matching file', async () => {
			const result = await processMarkdown('See [[TODO]] for tasks.', sampleFileTree, '');
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});

		it('converts wiki link with full path', async () => {
			const result = await processMarkdown(
				'Check [[OPSWAT/Meetings/OP-0088]] for meeting notes.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('converts wiki link with .md extension', async () => {
			const result = await processMarkdown('See [[README.md]] for info.', sampleFileTree, '');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('does not convert non-existent wiki links', async () => {
			const result = await processMarkdown(
				'See [[NonExistent File]] for details.',
				sampleFileTree,
				''
			);
			// Should not create a maestro-file link for non-existent files
			expect(result).not.toContain('maestro-file://');
			// The brackets will be escaped by remark-stringify
			expect(result).toContain('NonExistent File');
		});

		it('handles multiple wiki links in same text', async () => {
			const result = await processMarkdown(
				'Check [[TODO]] and [[README.md]] for updates.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('converts wiki link with alias (pipe syntax)', async () => {
			const result = await processMarkdown(
				'Established in 2024: [[Notes/TODO|my tasks]]',
				sampleFileTree,
				''
			);
			expect(result).toContain('[my tasks](maestro-file://Notes/TODO.md)');
		});

		it('converts wiki link with alias and spaces in display text', async () => {
			const result = await processMarkdown(
				'See [[OPSWAT/README|OPSWAT Documentation]] for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[OPSWAT Documentation](maestro-file://OPSWAT/README.md)');
		});

		it('converts wiki link with alias preserving original display', async () => {
			const result = await processMarkdown(
				'Check the [[config.json|configuration file]] settings.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[configuration file](maestro-file://config.json)');
		});

		it('handles alias with complex path', async () => {
			const result = await processMarkdown(
				'Meeting details: [[OPSWAT/Meetings/OP-0088|ELT Call Notes]]',
				sampleFileTree,
				''
			);
			expect(result).toContain('[ELT Call Notes](maestro-file://OPSWAT/Meetings/OP-0088.md)');
		});
	});

	describe('duplicate filename resolution', () => {
		it('picks closest file to cwd when multiple matches exist', async () => {
			// With cwd in Notes, Notes/Meeting Notes.md should be closer
			const result = await processMarkdown(
				'See [[Meeting Notes]] for details.',
				sampleFileTree,
				'Notes'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Meeting Notes](<maestro-file://Notes/Meeting Notes.md>)');
		});

		it('picks file in Archive when cwd is Archive', async () => {
			const result = await processMarkdown(
				'See [[Meeting Notes]] for details.',
				sampleFileTree,
				'Archive'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)');
		});

		it('disambiguates with partial path', async () => {
			const result = await processMarkdown(
				'See [[Notes/Meeting Notes]] for details.',
				sampleFileTree,
				''
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Notes/Meeting Notes](<maestro-file://Notes/Meeting Notes.md>)');
		});
	});

	describe('edge cases', () => {
		it('handles empty file tree', async () => {
			const result = await processMarkdown('See OPSWAT/Meetings/OP-0088 for details.', [], '');
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('OPSWAT/Meetings/OP-0088');
		});

		it('handles text with no file references', async () => {
			const result = await processMarkdown(
				'This is just regular text with no file references.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('This is just regular text');
		});

		it('preserves existing markdown links', async () => {
			const result = await processMarkdown(
				'Check [Google](https://google.com) for search.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[Google](https://google.com)');
		});

		it('handles file references inside code blocks (should not convert)', async () => {
			const result = await processMarkdown('```\nOPSWAT/Meetings/OP-0088\n```', sampleFileTree, '');
			// Code blocks content should remain unchanged
			expect(result).toContain('OPSWAT/Meetings/OP-0088');
		});

		it('handles inline code (should not convert)', async () => {
			const result = await processMarkdown(
				'Run `OPSWAT/Meetings/OP-0088` command.',
				sampleFileTree,
				''
			);
			// The plugin operates on text nodes, inline code is a different node type
			expect(result).toContain('`OPSWAT/Meetings/OP-0088`');
		});

		it('handles mixed path and wiki links', async () => {
			const result = await processMarkdown(
				'See OPSWAT/README.md and [[TODO]] for info.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[OPSWAT/README.md](maestro-file://OPSWAT/README.md)');
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});
	});

	describe('proximity calculation', () => {
		it('calculates proximity correctly for nested paths', async () => {
			// Create a tree where files are at different depths
			const deepTree: FileNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [
						{
							name: 'b',
							type: 'folder',
							children: [{ name: 'target.md', type: 'file' }],
						},
					],
				},
				{
					name: 'x',
					type: 'folder',
					children: [{ name: 'target.md', type: 'file' }],
				},
			];

			// With cwd at 'a/b', the a/b/target.md should be closest
			const result = await processMarkdown('See [[target]] for details.', deepTree, 'a/b');
			expect(result).toContain('[target](maestro-file://a/b/target.md)');
		});
	});

	describe('absolute path references', () => {
		it('converts absolute paths when projectRoot is provided', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/README.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/README.md](maestro-file://OPSWAT/README.md)'
			);
		});

		it('converts absolute paths outside projectRoot to file:// links', async () => {
			const result = await processMarkdown(
				'See /other/path/README.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Outside projectRoot, so it gets the same file:// treatment as a tilde
			// path - openFileUrl routes it to the preview tab, player, or the OS.
			expect(result).toContain('[/other/path/README.md](file:///other/path/README.md)');
			expect(result).not.toContain('maestro-file://');
		});

		it('does not convert absolute paths when projectRoot is not provided', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/README.md for details.',
				sampleFileTree,
				''
			);
			// Should not be converted since projectRoot is not provided
			expect(result).toContain('/Users/pedram/Project/OPSWAT/README.md');
			expect(result).not.toContain('maestro-file://');
		});

		it('handles absolute paths with spaces in folder/file names', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/Notes/Meeting Notes.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain(
				'[/Users/pedram/Project/Notes/Meeting Notes.md](<maestro-file://Notes/Meeting Notes.md>)'
			);
		});

		it('handles absolute paths with dashes and complex names', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/Meetings/OP-0088.md - May 2025',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('handles multiple absolute paths in bulleted list', async () => {
			const result = await processMarkdown(
				'• /Users/pedram/Project/OPSWAT/Meetings/OP-0088.md - first\n• /Users/pedram/Project/OPSWAT/Meetings/OP-0200.md - second',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0200.md](maestro-file://OPSWAT/Meetings/OP-0200.md)'
			);
		});

		it('links absolute paths even when file is not in file tree', async () => {
			// This file does NOT exist in sampleFileTree, but should still be linked
			// because absolute paths are explicit - the file click handler will try to open it
			const result = await processMarkdown(
				'See /Users/pedram/Project/SomeOther/NonExistent File.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should still create a link because path is within projectRoot
			expect(result).toContain(
				'[/Users/pedram/Project/SomeOther/NonExistent File.md](<maestro-file://SomeOther/NonExistent File.md>)'
			);
		});
	});

	describe('markdown links with absolute path hrefs', () => {
		it('converts markdown link with absolute path href to maestro-file link', async () => {
			// Agents like Codex emit [display](absolute-path) style links
			const result = await processMarkdown(
				'Modified [src/components/CameraModal.tsx](/Users/pedram/Project/src/components/CameraModal.tsx) to add callback.',
				[
					{
						name: 'src',
						type: 'folder',
						children: [
							{
								name: 'components',
								type: 'folder',
								children: [{ name: 'CameraModal.tsx', type: 'file' }],
							},
						],
					},
				],
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[src/components/CameraModal.tsx](maestro-file://src/components/CameraModal.tsx)'
			);
		});

		it('converts markdown link with absolute path href even when file not in tree', async () => {
			// Absolute paths within projectRoot should link even without file tree match
			const result = await processMarkdown(
				'See [App.tsx](/Users/pedram/Project/src/App.tsx) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[App.tsx](maestro-file://src/App.tsx)');
		});

		it('converts markdown link with absolute path outside projectRoot to file:// URL', async () => {
			const result = await processMarkdown(
				'See [file.tsx](/other/path/file.tsx) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[file.tsx](file:///other/path/file.tsx)');
			expect(result).not.toContain('maestro-file://');
		});

		it('converts markdown link with tilde path href to maestro-file link', async () => {
			const result = await processMarkdown(
				'See [README.md](~/Project/OPSWAT/README.md) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts markdown link with tilde path outside projectRoot to file:// URL', async () => {
			const result = await processMarkdown(
				'See [notes.md](~/Documents/notes.md) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[notes.md](file:///Users/pedram/Documents/notes.md)');
		});
	});

	describe('inline code paths (backticks)', () => {
		it('converts absolute path in backticks to link with filename display', async () => {
			const result = await processMarkdown(
				'Check `/Users/pedram/Project/OPSWAT/README.md` for info.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to link showing just the filename
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
			// Should NOT contain backticks around the path anymore
			expect(result).not.toContain('`/Users/pedram/Project/OPSWAT/README.md`');
		});

		it('converts absolute path in backticks outside projectRoot to file:// link', async () => {
			const result = await processMarkdown(
				'Check `/Volumes/Audio/takes/recording.wav` for the take.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[recording.wav](file:///Volumes/Audio/takes/recording.wav)');
			expect(result).not.toContain('maestro-file://');
		});

		it('converts relative path in backticks to link when file exists', async () => {
			const result = await processMarkdown(
				'See `OPSWAT/README.md` for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts wiki link in backticks to link', async () => {
			const result = await processMarkdown(
				'Reference `[[OPSWAT/README]]` here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[OPSWAT/README](maestro-file://OPSWAT/README.md)');
		});

		it('leaves non-path inline code unchanged', async () => {
			const result = await processMarkdown(
				'Use `npm install` to install.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('`npm install`');
		});

		it('handles absolute path with spaces in backticks', async () => {
			const result = await processMarkdown(
				'File: `/Users/pedram/Project/Notes/Meeting Notes.md`',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// remark-stringify adds angle brackets around URLs with spaces
			expect(result).toContain('[Meeting Notes.md](<maestro-file://Notes/Meeting Notes.md>)');
		});
	});

	describe('image embeds', () => {
		it('converts image embed to inline image', async () => {
			const result = await processMarkdown(
				'Here is the screenshot: ![[Pasted image 20250519123910.png]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to markdown image with file:// URL
			expect(result).toContain('![Pasted image 20250519123910.png]');
			expect(result).toContain(
				'file:///Users/pedram/Project/attachments/Pasted image 20250519123910.png'
			);
			// Should NOT contain the original embed syntax
			expect(result).not.toContain('![[');
		});

		it('converts image embed with path', async () => {
			const result = await processMarkdown(
				'See ![[attachments/screenshot.jpg]] for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![attachments/screenshot.jpg]');
			expect(result).toContain('file:///Users/pedram/Project/attachments/screenshot.jpg');
		});

		it('converts image embed even when not in file tree (uses _attachments fallback)', async () => {
			const result = await processMarkdown(
				'Missing: ![[nonexistent.png]]',
				sampleFileTree,
				'some/folder',
				'/Users/pedram/Project'
			);
			// Should still create an image with _attachments fallback path
			// With projectRoot and cwd, full path is: projectRoot/cwd/_attachments/image
			expect(result).toContain('![nonexistent.png]');
			expect(result).toContain(
				'file:///Users/pedram/Project/some/folder/_attachments/nonexistent.png'
			);
		});

		it('handles multiple image embeds', async () => {
			const result = await processMarkdown(
				'First ![[screenshot.jpg]] and second ![[Pasted image 20250519123910.png]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![screenshot.jpg]');
			expect(result).toContain('![Pasted image 20250519123910.png]');
		});

		it('handles image embed mixed with wiki links', async () => {
			const result = await processMarkdown(
				'Image: ![[screenshot.jpg]] and link: [[README]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Image should be converted
			expect(result).toContain('![screenshot.jpg]');
			// Link should also be converted
			expect(result).toContain('[README](maestro-file://README.md)');
		});

		it('handles image embed with width syntax', async () => {
			const result = await processMarkdown(
				'Resized: ![[screenshot.jpg|300]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to image
			expect(result).toContain('![screenshot.jpg]');
			// Should include the file URL
			expect(result).toContain('file:///Users/pedram/Project/attachments/screenshot.jpg');
		});

		it('handles image embed with width and spaces in filename', async () => {
			const result = await processMarkdown(
				'Image: ![[Pasted image 20250519123910.png|500]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![Pasted image 20250519123910.png]');
		});
	});

	describe('buildFileTreeIndices', () => {
		it('builds allPaths Set containing all file paths', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			expect(indices.allPaths).toBeInstanceOf(Set);
			expect(indices.allPaths.has('README.md')).toBe(true);
			expect(indices.allPaths.has('config.json')).toBe(true);
			expect(indices.allPaths.has('OPSWAT/README.md')).toBe(true);
			expect(indices.allPaths.has('OPSWAT/Meetings/OP-0088.md')).toBe(true);
			expect(indices.allPaths.has('Notes/TODO.md')).toBe(true);
		});

		it('builds filenameIndex Map for quick filename lookup', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			expect(indices.filenameIndex).toBeInstanceOf(Map);
			// README.md exists in multiple locations
			const readmePaths = indices.filenameIndex.get('README.md');
			expect(readmePaths).toBeDefined();
			expect(readmePaths).toContain('README.md');
			expect(readmePaths).toContain('OPSWAT/README.md');
		});

		it('handles duplicate filenames correctly', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			// Meeting Notes.md exists in both Notes and Archive
			const meetingNotesPaths = indices.filenameIndex.get('Meeting Notes.md');
			expect(meetingNotesPaths).toBeDefined();
			expect(meetingNotesPaths?.length).toBe(2);
			expect(meetingNotesPaths).toContain('Notes/Meeting Notes.md');
			expect(meetingNotesPaths).toContain('Archive/Meeting Notes.md');
		});

		it('returns empty indices for empty file tree', () => {
			const indices = buildFileTreeIndices([]);

			expect(indices.allPaths.size).toBe(0);
			expect(indices.filenameIndex.size).toBe(0);
		});

		it('does not include folder paths, only files', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			// Folders should not be in the paths
			expect(indices.allPaths.has('OPSWAT')).toBe(false);
			expect(indices.allPaths.has('Notes')).toBe(false);
			expect(indices.allPaths.has('attachments')).toBe(false);
		});
	});

	describe('extended file extensions', () => {
		it('converts media file references (wav, mp3, etc.)', async () => {
			const result = await processMarkdown(
				'Listen to output/recording.wav for the sample.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[output/recording.wav](maestro-file://output/recording.wav)');
		});

		it('converts document file references (pdf, csv, etc.)', async () => {
			const result = await processMarkdown(
				'See output/report.pdf and output/data.csv for results.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[output/report.pdf](maestro-file://output/report.pdf)');
			expect(result).toContain('[output/data.csv](maestro-file://output/data.csv)');
		});

		it('converts absolute paths with media extensions', async () => {
			const result = await processMarkdown(
				'File at /Users/pedram/Project/output/recording.wav here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/output/recording.wav](maestro-file://output/recording.wav)'
			);
		});

		it('converts absolute media paths outside projectRoot to file:// links', async () => {
			// The floating player is reached through openFileUrl, which only ever
			// sees a file:// href - a bare absolute path is a dead link.
			const result = await processMarkdown(
				'File at /Volumes/Audio/takes/recording.wav here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Volumes/Audio/takes/recording.wav](file:///Volumes/Audio/takes/recording.wav)'
			);
		});
	});

	describe('tilde path references', () => {
		it('converts tilde paths within projectRoot to maestro-file links', async () => {
			const result = await processMarkdown(
				'See ~/Project/output/recording.wav for the audio.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain(
				'[~/Project/output/recording.wav](maestro-file://output/recording.wav)'
			);
		});

		it('converts tilde paths outside projectRoot to file:// links', async () => {
			const result = await processMarkdown(
				'See ~/Downloads/audio/sample.wav for the sample.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain(
				'[~/Downloads/audio/sample.wav](file:///Users/pedram/Downloads/audio/sample.wav)'
			);
		});

		it('does not convert tilde paths when homeDir is not provided', async () => {
			const result = await processMarkdown(
				'See ~/Downloads/audio/sample.wav for the sample.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).not.toContain('file://');
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('~/Downloads/audio/sample.wav');
		});

		it('handles multiple tilde paths in same text', async () => {
			const result = await processMarkdown(
				'Compare ~/Downloads/a.wav and ~/Downloads/b.mp3 side by side.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[~/Downloads/a.wav](file:///Users/pedram/Downloads/a.wav)');
			expect(result).toContain('[~/Downloads/b.mp3](file:///Users/pedram/Downloads/b.mp3)');
		});

		it('converts tilde path in inline code', async () => {
			const result = await processMarkdown(
				'Check `~/Downloads/audio/sample.wav` for the file.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[sample.wav](file:///Users/pedram/Downloads/audio/sample.wav)');
			expect(result).not.toContain('`~/Downloads');
		});

		it('converts tilde path in inline code within projectRoot', async () => {
			const result = await processMarkdown(
				'See `~/Project/output/recording.wav` here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[recording.wav](maestro-file://output/recording.wav)');
		});
	});

	describe('bare maestro:// deep links', () => {
		it('auto-linkifies a bare maestro:// URL in running text', async () => {
			const result = await processMarkdown(
				'Go to maestro://session/abc/tab/xyz now.',
				sampleFileTree,
				''
			);
			// remark-stringify emits CommonMark autolinks as <url> when the link
			// text equals the URL, which is what we get when we wrap a bare URL.
			expect(result).toContain('<maestro://session/abc/tab/xyz>');
		});

		it('does not rewrite an explicit markdown link with a maestro:// href', async () => {
			const result = await processMarkdown(
				'See [the agent](maestro://group/grp1).',
				sampleFileTree,
				''
			);
			expect(result).toContain('[the agent](maestro://group/grp1)');
			expect(result).not.toContain('maestro-file://');
		});
	});

	describe('remarkFileLinks with pre-built indices', () => {
		it('uses pre-built indices when provided', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: '' })
				.use(remarkStringify)
				.process('See [[TODO]] for tasks.');

			expect(String(result)).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});

		it('works with pre-built indices for path-style references', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: '' })
				.use(remarkStringify)
				.process('Check OPSWAT/Meetings/OP-0088.md for details.');

			expect(String(result)).toContain(
				'[OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('handles cwd-based proximity with pre-built indices', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: 'Archive' })
				.use(remarkStringify)
				.process('See [[Meeting Notes]] for details.');

			// Should pick Archive/Meeting Notes.md based on cwd proximity
			expect(String(result)).toContain(
				'[Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)'
			);
		});
	});

	describe('malformed percent-encoding in link targets (MAESTRO-XS)', () => {
		// decodeURIComponent throws URIError on a stray '%'. This plugin runs
		// inside the unified transform, so the throw escaped react-markdown's
		// render and blanked the entire message body in chat.
		const cases = [
			['a bare percent', '[see](100% done.md)'],
			['a truncated escape', '[see](report%E0%A4%A.md)'],
			['an invalid hex pair', '[see](weird%ZZ.md)'],
			['a trailing percent', '[see](draft%)'],
		];

		for (const [label, markdown] of cases) {
			it(`does not throw on ${label}`, async () => {
				await expect(
					processMarkdown(markdown, sampleFileTree, '', '/project')
				).resolves.toBeTruthy();
			});
		}

		it('leaves an unresolvable malformed target as-is', async () => {
			const result = await processMarkdown('[see](100% done.md)', sampleFileTree, '');
			expect(result).not.toContain('maestro-file://');
		});

		it('still resolves valid escapes to maestro-file:// links', async () => {
			const tree: FileNode[] = [{ name: 'My Notes.md', type: 'file', path: 'My Notes.md' }];
			const result = await processMarkdown('[notes](My%20Notes.md)', tree, '');
			expect(result).toContain('maestro-file://My Notes.md');
		});
	});
});

// ===== from src/__tests__/renderer/utils/shortcutRecorder.test.ts =====

function mkEvent(
	overrides: Partial<{
		key: string;
		code: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	}>
): React.KeyboardEvent {
	return {
		key: '',
		code: '',
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	} as unknown as React.KeyboardEvent;
}

describe('buildKeysFromEvent', () => {
	it('returns null when only a modifier is pressed', () => {
		expect(buildKeysFromEvent(mkEvent({ key: 'Meta', metaKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Alt', altKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
	});

	it('builds a plain Meta+letter combo', () => {
		expect(buildKeysFromEvent(mkEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toEqual([
			'Meta',
			'k',
		]);
	});

	it('orders modifiers as Meta, Ctrl, Alt, Shift', () => {
		const keys = buildKeysFromEvent(
			mkEvent({
				key: 'x',
				code: 'KeyX',
				metaKey: true,
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
			})
		);
		expect(keys).toEqual(['Meta', 'Ctrl', 'Alt', 'Shift', 'x']);
	});

	it('recovers physical letter key when Alt rewrites e.key (macOS Alt+p = π)', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: 'π', code: 'KeyP', altKey: true }));
		expect(keys).toEqual(['Alt', 'p']);
	});

	it('recovers physical digit key when Alt rewrites e.key', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: '¡', code: 'Digit1', altKey: true }));
		expect(keys).toEqual(['Alt', '1']);
	});

	it('leaves non-letter/digit keys alone under Alt', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }));
		expect(keys).toEqual(['Alt', 'ArrowLeft']);
	});

	it('uses e.key directly when Alt is not held', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: '/', code: 'Slash', metaKey: true }));
		expect(keys).toEqual(['Meta', '/']);
	});
});

describe('buildEventFromKeys', () => {
	it('returns null for an empty key array', () => {
		expect(buildEventFromKeys([])).toBeNull();
	});

	it('sets the modifier flags named in the key array', () => {
		const e = buildEventFromKeys(['Alt', 'Meta', 'Shift', 'w'])!;
		expect(e.metaKey).toBe(true);
		expect(e.altKey).toBe(true);
		expect(e.shiftKey).toBe(true);
		expect(e.ctrlKey).toBe(false);
		expect(e.key).toBe('w');
	});

	it('treats Ctrl and Control as the same modifier', () => {
		expect(buildEventFromKeys(['Ctrl', 'd'])!.ctrlKey).toBe(true);
		expect(buildEventFromKeys(['Control', 'd'])!.ctrlKey).toBe(true);
	});

	it('populates e.code so Alt combos still match by physical key', () => {
		// A real macOS Alt+Q reports key 'œ'; isShortcut falls back to e.code.
		expect(buildEventFromKeys(['Alt', 'q'])!.code).toBe('KeyQ');
		expect(buildEventFromKeys(['Alt', 'Meta', '1'])!.code).toBe('Digit1');
	});

	it('maps punctuation keys to their physical code names', () => {
		expect(buildEventFromKeys(['Meta', ','])!.code).toBe('Comma');
		expect(buildEventFromKeys(['Meta', '/'])!.code).toBe('Slash');
		expect(buildEventFromKeys(['Meta', 'Shift', '['])!.code).toBe('BracketLeft');
	});

	it('leaves named keys as their own code', () => {
		expect(buildEventFromKeys(['Alt', 'Meta', 'ArrowLeft'])!.code).toBe('ArrowLeft');
		expect(buildEventFromKeys(['Meta', 'Shift', 'Backspace'])!.code).toBe('Backspace');
	});

	it('round-trips through buildKeysFromEvent', () => {
		// buildKeysFromEvent emits modifiers in its own canonical order, so compare
		// the key sets rather than the arrays.
		for (const keys of [
			['Meta', 'j'],
			['Alt', 'Meta', 'ArrowLeft'],
			['Meta', 'Shift', 'Backspace'],
			['Alt', 'q'],
		]) {
			const replayed = buildEventFromKeys(keys)!;
			const recorded = buildKeysFromEvent(replayed as unknown as React.KeyboardEvent);
			expect(recorded?.slice().sort()).toEqual(keys.slice().sort());
		}
	});

	it('bubbles and is cancelable so window-level handlers can preventDefault', () => {
		const e = buildEventFromKeys(['Meta', 'k'])!;
		expect(e.bubbles).toBe(true);
		expect(e.cancelable).toBe(true);
		expect(e.type).toBe('keydown');
	});
});

// ===== from src/__tests__/renderer/utils/sidebarMembership.test.ts =====

const agent = (overrides: Partial<Session> = {}) => createMockSession(overrides);

describe('sessionMatchesFilter', () => {
	it('matches everything on an empty or whitespace query', () => {
		const s = agent({ name: 'Alpha' });
		expect(sessionMatchesFilter(s, '')).toBe(true);
		expect(sessionMatchesFilter(s, '   ')).toBe(true);
	});

	it('matches the agent name, case-insensitively', () => {
		const s = agent({ name: 'Payments API' });
		expect(sessionMatchesFilter(s, 'payments')).toBe(true);
		expect(sessionMatchesFilter(s, 'PAY')).toBe(true);
		expect(sessionMatchesFilter(s, 'billing')).toBe(false);
	});

	it('matches an AI tab name', () => {
		const s = agent({
			name: 'Alpha',
			aiTabs: [{ id: 't1', name: 'Refactor parser' }] as never,
		});
		expect(sessionMatchesFilter(s, 'parser')).toBe(true);
	});

	// A hidden consult tab is not on screen, so its generated name must not keep an
	// agent in the filtered list.
	it('does not match a hidden consult tab name', () => {
		const s = agent({
			name: 'Alpha',
			aiTabs: [{ id: 't1', name: '\u21a9 Beta', hidden: true }] as never,
		});
		expect(sessionMatchesFilter(s, 'beta')).toBe(false);
	});

	// A user filtering for a branch expects the parent row that owns the worktree,
	// since the child is drawn underneath it rather than as a row of its own.
	it('matches a worktree child by branch name or by name', () => {
		const parent = agent({ id: 'p', name: 'Alpha' });
		const children = [agent({ id: 'c', name: 'Alpha (wt)', worktreeBranch: 'feat/tokens' })];
		expect(sessionMatchesFilter(parent, 'feat/tok', children)).toBe(true);
		expect(sessionMatchesFilter(parent, '(wt)', children)).toBe(true);
		expect(sessionMatchesFilter(parent, 'nope', children)).toBe(false);
	});

	it('tolerates an agent with no AI tabs and no children', () => {
		expect(sessionMatchesFilter(agent({ name: 'Alpha', aiTabs: undefined }), 'zzz')).toBe(false);
	});
});

describe('passesUnreadFilter', () => {
	const on = { showUnreadAgentsOnly: true };

	it('passes everything when the filter is off', () => {
		expect(passesUnreadFilter(agent({ state: 'idle' }), { showUnreadAgentsOnly: false })).toBe(
			true
		);
	});

	it('drops a quiet agent when the filter is on', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'idle', aiTabs: [] }), on)).toBe(false);
	});

	it('keeps an agent with an unread tab', () => {
		const s = agent({ id: 'a', state: 'idle', aiTabs: [{ id: 't', hasUnread: true }] as never });
		expect(passesUnreadFilter(s, on)).toBe(true);
	});

	it('keeps a busy agent', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'busy', aiTabs: [] }), on)).toBe(true);
	});

	// An agent that failed is the case this filter most needs to surface. It used
	// to be dropped, so a crashed agent with no unread tabs vanished from the very
	// filter you would open to find it.
	it('keeps an errored agent even with no unread tabs', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'error', aiTabs: [] }), on)).toBe(true);
	});

	// An Auto Run agent sits idle between prompts and a stuck one is not "unread"
	// in any literal sense, but both need attention.
	it('keeps an Auto Run agent and a stuck agent', () => {
		const s = agent({ id: 'a', state: 'idle', aiTabs: [] });
		expect(passesUnreadFilter(s, { ...on, batchSessionIds: new Set(['a']) })).toBe(true);
		expect(passesUnreadFilter(s, { ...on, stuckOutageIds: new Set(['a']) })).toBe(true);
	});

	// A filter that hides the row you are working in loses your place, and the
	// cycle would then have no valid position to move from.
	it('always keeps the active agent, and the parent of an active worktree child', () => {
		const quiet = agent({ id: 'a', state: 'idle', aiTabs: [] });
		expect(passesUnreadFilter(quiet, { ...on, activeSessionId: 'a' })).toBe(true);

		const parent = agent({ id: 'p', state: 'idle', aiTabs: [] });
		const children = [agent({ id: 'c', state: 'idle', aiTabs: [] })];
		expect(
			passesUnreadFilter(parent, { ...on, activeSessionId: 'c', worktreeChildren: children })
		).toBe(true);
	});

	it('keeps a parent whose worktree child needs attention', () => {
		const parent = agent({ id: 'p', state: 'idle', aiTabs: [] });
		const busyChild = [agent({ id: 'c', state: 'busy', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: busyChild })).toBe(true);

		const errorChild = [agent({ id: 'c', state: 'error', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: errorChild })).toBe(true);

		const quietChild = [agent({ id: 'c', state: 'idle', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: quietChild })).toBe(false);
	});
});

// ===== from src/__tests__/renderer/utils/splitOnMatches.test.ts =====

describe('splitOnMatches', () => {
	it('returns the whole string as one non-match when there is no query', () => {
		expect(splitOnMatches('pedram', '')).toEqual([{ text: 'pedram', isMatch: false, start: 0 }]);
	});

	it('splits a single hit into before / match / after', () => {
		expect(splitOnMatches('ask pedram now', 'pedram')).toEqual([
			{ text: 'ask ', isMatch: false, start: 0 },
			{ text: 'pedram', isMatch: true, start: 4 },
			{ text: ' now', isMatch: false, start: 10 },
		]);
	});

	it('matches case-insensitively but keeps the original casing', () => {
		const segments = splitOnMatches('Pedram and PEDRAM', 'pedram');
		expect(segments.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['Pedram', 'PEDRAM']);
	});

	it('finds every occurrence, not just the first', () => {
		const segments = splitOnMatches('a b a b a', 'a');
		expect(segments.filter((s) => s.isMatch)).toHaveLength(3);
	});

	it('gives repeated substrings distinct offsets, so keys stay unique', () => {
		const starts = splitOnMatches('aa aa aa', 'aa')
			.filter((s) => s.isMatch)
			.map((s) => s.start);
		expect(starts).toEqual([0, 3, 6]);
		expect(new Set(starts).size).toBe(starts.length);
	});

	it('reassembles into exactly the original string', () => {
		// The overlay lays its segments out to match the textarea character for
		// character; dropping or duplicating one would shift every mark after it.
		const text = 'Line one\nline TWO with tricky $chars\n\nend';
		expect(
			splitOnMatches(text, 'line')
				.map((s) => s.text)
				.join('')
		).toBe(text);
	});

	it('treats regex metacharacters in the query as literal text', () => {
		// A user typing `a.b` or `$100` must not have it compiled as a pattern.
		const segments = splitOnMatches('cost $100 and a.b', '$100');
		expect(segments.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['$100']);

		const dotted = splitOnMatches('a.b and axb', 'a.b');
		expect(dotted.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['a.b']);
	});

	it('returns a single non-match run when nothing matches', () => {
		expect(splitOnMatches('hello', 'zzz')).toEqual([{ text: 'hello', isMatch: false, start: 0 }]);
	});
});
