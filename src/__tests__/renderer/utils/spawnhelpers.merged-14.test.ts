// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/utils/spawnHelpers.test.ts
//   - src/__tests__/renderer/utils/tabExport.test.ts
//   - src/__tests__/renderer/utils/terminalKeys.test.ts
//   - src/__tests__/renderer/utils/textareaSizing.test.ts
//   - src/__tests__/renderer/utils/thinkingItems.test.ts

import type { AITab, LogEntry, Theme } from '../../../renderer/types';
import { prepareMaestroSystemPrompt } from '../../../renderer/utils/spawnHelpers';
import { generateTabExportHtml } from '../../../renderer/utils/tabExport';
import { TERMINAL_KEY_SEQUENCES, toControlChar } from '../../../renderer/utils/terminalKeys';
import {
	clampTextareaHeight,
	normalizeTextareaHeight,
	resizeTextareaToContent,
	resolveTextareaHeight,
	sanitizeTextareaHeights,
	scrollTextareaToCaretEnd,
} from '../../../renderer/utils/textareaSizing';
import { buildThinkingItems } from '../../../renderer/utils/thinkingItems';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { mockTheme } from '../../helpers/mockTheme';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((content: string, vars: Record<string, any>) => {
		let result = content;
		for (const [key, value] of Object.entries(vars)) {
			if (typeof value === 'string') {
				result = result.replace(`{{${key}}}`, value);
			}
		}
		return result;
	}),
}));
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
	},
}));
vi.mock('marked', () => ({
	marked: {
		parse: (text: string) => `<p>${text}</p>`,
		setOptions: vi.fn(),
	},
}));

// ===== from src/__tests__/renderer/utils/spawnHelpers.test.ts =====

describe('prepareMaestroSystemPrompt', () => {
	const baseSession = {
		id: 'session-1',
		cwd: '/test/project',
		isGitRepo: false,
		groupId: 'group-1',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			...(window as any).maestro,
			prompts: {
				get: vi.fn().mockResolvedValue({
					success: true,
					content: 'System prompt for {{activeTabId}}',
				}),
			},
			history: {
				getFilePath: vi.fn().mockResolvedValue('/mock/history/path.jsonl'),
			},
		};
	});

	it('returns undefined when prompt load fails', async () => {
		(window as any).maestro.prompts.get.mockResolvedValue({
			success: false,
			error: 'not found',
		});
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeUndefined();
	});

	it('returns undefined when prompt content is empty', async () => {
		(window as any).maestro.prompts.get.mockResolvedValue({
			success: true,
			content: '',
		});
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeUndefined();
	});

	it('returns substituted prompt', async () => {
		const result = await prepareMaestroSystemPrompt({
			session: baseSession,
			activeTabId: 'tab-42',
		});
		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('maestro-system-prompt');
	});

	it('resolves git branch when session is a git repo', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		const result = await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: true },
		});
		expect(result).toBeDefined();
		expect(gitService.getStatus).toHaveBeenCalledWith('/test/project');
	});

	it('skips git branch when session is not a git repo', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: false },
		});
		expect(gitService.getStatus).not.toHaveBeenCalled();
	});

	it('handles git status errors gracefully', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		vi.mocked(gitService.getStatus).mockRejectedValueOnce(new Error('git failed'));
		const result = await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: true },
		});
		expect(result).toBeDefined();
	});

	it('fetches history file path for non-SSH sessions', async () => {
		await prepareMaestroSystemPrompt({ session: baseSession });
		expect((window as any).maestro.history.getFilePath).toHaveBeenCalledWith('session-1');
	});

	it('skips history file path for SSH sessions (sshRemoteId)', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sshRemoteId: 'remote-1' },
		});
		expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
	});

	it('skips history file path for SSH sessions (sessionSshRemoteConfig)', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
		});
		expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
	});

	it('handles history file path errors gracefully', async () => {
		(window as any).maestro.history.getFilePath.mockRejectedValueOnce(new Error('history failed'));
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeDefined();
	});

	it('re-injects prompt on every call (no resume-based skip)', async () => {
		// Regression: prior impl returned undefined when a legacy `agentSessionId`
		// was present. Because Claude Code's --append-system-prompt is NOT persisted
		// into the session transcript, resuming with `--resume` dropped the Maestro
		// prompt from turn 2 onward. The prompt MUST be re-injected on every spawn.
		const first = await prepareMaestroSystemPrompt({ session: baseSession });
		const second = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect((window as any).maestro.prompts.get).toHaveBeenCalledTimes(2);
	});
});

// ===== from src/__tests__/renderer/utils/tabExport.test.ts =====

// Mock theme for testing

const mockSession = {
	name: 'My Session',
	cwd: '/home/user/project',
	toolType: 'claude-code',
};

function createLogEntry(overrides?: Partial<LogEntry>): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Hello world',
		...overrides,
	};
}

function createMockTab(overrides?: Partial<AITab>): AITab {
	return createMockAITab({
		id: 'tab-001',
		agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
		name: 'Test Tab',
		createdAt: 1703116800000, // 2023-12-21T00:00:00.000Z
		...overrides,
	});
}

describe('tabExport', () => {
	describe('generateTabExportHtml', () => {
		describe('basic HTML structure', () => {
			it('returns valid HTML with DOCTYPE, head, and body', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('<html lang="en">');
				expect(html).toContain('</html>');
				expect(html).toContain('<head>');
				expect(html).toContain('</head>');
				expect(html).toContain('<body>');
				expect(html).toContain('</body>');
			});

			it('includes meta charset and viewport tags', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<meta charset="UTF-8">');
				expect(html).toContain('<meta name="viewport"');
			});

			it('includes embedded CSS styles', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<style>');
				expect(html).toContain('</style>');
			});
		});

		describe('tab name display and fallbacks', () => {
			it('includes tab name in title and header when name is provided', () => {
				const tab = createMockTab({ name: 'My Custom Tab' });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<title>My Custom Tab - Maestro Tab Export</title>');
				// Also check the header h1
				expect(html).toContain('My Custom Tab');
			});

			it('falls back to session ID prefix when no name is provided', () => {
				const tab = createMockTab({
					name: null,
					agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('ABC12345');
				expect(html).toContain('<title>ABC12345 - Maestro Tab Export</title>');
			});

			it('falls back to "New Session" when no name or session ID', () => {
				const tab = createMockTab({ name: null, agentSessionId: null });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// getTabDisplayName returns 'New Session' for unnamed tabs without agentSessionId
				expect(html).toContain('New Session');
				expect(html).toContain('<title>New Session - Maestro Tab Export</title>');
			});
		});

		describe('theme colors', () => {
			it('applies theme colors as CSS variables', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('--bg-primary: #282a36');
				expect(html).toContain('--bg-secondary: #21222c');
				expect(html).toContain('--bg-tertiary: #343746');
				expect(html).toContain('--text-primary: #f8f8f2');
				expect(html).toContain('--text-secondary: #6272a4');
				expect(html).toContain('--text-dim: #6272a4');
				expect(html).toContain('--border: #44475a');
				expect(html).toContain('--accent: #bd93f9');
				expect(html).toContain('--accent-dim: rgba(189, 147, 249, 0.2)');
				expect(html).toContain('--success: #50fa7b');
				expect(html).toContain('--warning: #ffb86c');
				expect(html).toContain('--error: #ff5555');
			});

			it('uses different theme colors when provided', () => {
				const lightTheme: Theme = {
					id: 'github-light',
					name: 'GitHub Light',
					mode: 'light',
					colors: {
						bgMain: '#ffffff',
						bgSidebar: '#f6f8fa',
						bgActivity: '#f0f0f0',
						border: '#d0d7de',
						textMain: '#24292f',
						textDim: '#57606a',
						accent: '#0969da',
						accentDim: 'rgba(9, 105, 218, 0.1)',
						accentText: '#0969da',
						accentForeground: '#ffffff',
						success: '#1a7f37',
						warning: '#9a6700',
						error: '#cf222e',
					},
				};

				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, lightTheme);

				expect(html).toContain('--bg-primary: #ffffff');
				expect(html).toContain('--accent: #0969da');
				expect(html).toContain('Theme: GitHub Light');
			});

			it('includes theme name in footer', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Theme: Dracula');
			});
		});

		describe('message rendering', () => {
			it('renders user messages with message-user class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-user');
			});

			it('renders AI messages with message-agent class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'ai', text: 'Response' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('renders stdout messages with message-agent class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'stdout', text: 'Output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('renders error messages with message-agent class (not user)', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'error', text: 'Error occurred' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
				// Error messages should NOT have message-user
				expect(html).not.toMatch(/class="message message-user"[^>]*>.*Error occurred/s);
			});

			it('renders system messages with message-agent class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'system', text: 'System info' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('renders thinking messages with message-agent class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'thinking', text: 'Reasoning...' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('renders tool messages with message-agent class', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'tool', text: 'Tool output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('shows read-only badge for readOnly entries', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Query', readOnly: true })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('read-only-badge');
				expect(html).toContain('read-only');
			});

			it('does not show read-only badge when readOnly is false or absent', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Normal message', readOnly: false })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// The CSS class definition for read-only-badge will exist in the style section,
				// but the actual badge element should not appear in the message HTML
				expect(html).not.toContain('<span class="read-only-badge">read-only</span>');
			});

			it('displays correct source labels for each source type', () => {
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'User msg' }),
						createLogEntry({ source: 'ai', text: 'AI msg' }),
						createLogEntry({ source: 'error', text: 'Error msg' }),
						createLogEntry({ source: 'system', text: 'System msg' }),
						createLogEntry({ source: 'thinking', text: 'Thinking msg' }),
						createLogEntry({ source: 'tool', text: 'Tool msg' }),
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('User');
				expect(html).toContain('AI');
				expect(html).toContain('Error');
				expect(html).toContain('System');
				expect(html).toContain('Thinking');
				expect(html).toContain('Tool');
			});

			it('uses theme accent color for user messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.accent}"`);
			});

			it('uses theme success color for AI messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'ai', text: 'Reply' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.success}"`);
			});

			it('uses theme error color for error messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'error', text: 'Fail' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.error}"`);
			});

			it('uses theme warning color for system messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'system', text: 'Info' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.warning}"`);
			});

			it('uses theme textDim color for thinking messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'thinking', text: 'Hmm' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.textDim}"`);
			});

			it('uses theme accentDim color for tool messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'tool', text: 'Running' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.accentDim}"`);
			});
		});

		describe('stats grid', () => {
			it('shows correct total message count', () => {
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Q1' }),
						createLogEntry({ source: 'ai', text: 'A1' }),
						createLogEntry({ source: 'user', text: 'Q2' }),
						createLogEntry({ source: 'ai', text: 'A2' }),
						createLogEntry({ source: 'system', text: 'Info' }),
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// Total messages = 5
				expect(html).toContain('<div class="stat-value">5</div>');
			});

			it('shows correct user message count', () => {
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Q1' }),
						createLogEntry({ source: 'ai', text: 'A1' }),
						createLogEntry({ source: 'user', text: 'Q2' }),
						createLogEntry({ source: 'ai', text: 'A2' }),
						createLogEntry({ source: 'user', text: 'Q3' }),
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// User messages = 3
				expect(html).toContain('<div class="stat-value">3</div>');
			});

			it('counts AI messages including stdout source', () => {
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'ai', text: 'AI msg' }),
						createLogEntry({ source: 'stdout', text: 'Stdout msg' }),
						createLogEntry({ source: 'error', text: 'Error msg' }),
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// AI messages = 2 (ai + stdout)
				expect(html).toContain('<div class="stat-value">2</div>');
			});

			it('displays stat labels', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Q' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Messages');
				expect(html).toContain('User');
				expect(html).toContain('AI');
				expect(html).toContain('Duration');
			});

			it('shows zero counts for empty logs', () => {
				const tab = createMockTab({ logs: [] });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">0</div>');
			});
		});

		describe('duration calculation', () => {
			it('shows 0m for fewer than 2 log entries', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Alone' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">0m</div>');
			});

			it('shows 0m for empty logs', () => {
				const tab = createMockTab({ logs: [] });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">0m</div>');
			});

			it('shows minutes format for durations under 1 hour', () => {
				const baseTime = 1703116800000;
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Start', timestamp: baseTime }),
						createLogEntry({
							source: 'ai',
							text: 'End',
							timestamp: baseTime + 25 * 60 * 1000,
						}), // +25 minutes
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">25m</div>');
			});

			it('shows hours and minutes format for durations over 1 hour', () => {
				const baseTime = 1703116800000;
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Start', timestamp: baseTime }),
						createLogEntry({
							source: 'ai',
							text: 'End',
							timestamp: baseTime + 2 * 60 * 60 * 1000 + 30 * 60 * 1000,
						}), // +2h 30m
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">2h 30m</div>');
			});

			it('shows exact hour with 0 remaining minutes', () => {
				const baseTime = 1703116800000;
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Start', timestamp: baseTime }),
						createLogEntry({
							source: 'ai',
							text: 'End',
							timestamp: baseTime + 3 * 60 * 60 * 1000,
						}), // +3h exactly
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<div class="stat-value">3h 0m</div>');
			});
		});

		describe('usage stats formatting', () => {
			it('shows N/A when usageStats is undefined', () => {
				const tab = createMockTab({ usageStats: undefined });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('N/A');
			});

			it('formats token counts with locale separators', () => {
				const tab = createMockTab({
					usageStats: {
						inputTokens: 12345,
						outputTokens: 6789,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.0512,
						contextWindow: 200000,
					},
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// toLocaleString() formats with separators
				expect(html).toContain('12,345 input');
				expect(html).toContain('6,789 output');
			});

			it('formats cost with 4 decimal places', () => {
				const tab = createMockTab({
					usageStats: {
						inputTokens: 100,
						outputTokens: 200,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.1,
						contextWindow: 200000,
					},
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('$0.1000');
			});

			it('shows N/A when all stats values are zero/falsy', () => {
				const tab = createMockTab({
					usageStats: {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0,
						contextWindow: 200000,
					},
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// All values are 0 (falsy), so all parts are skipped -> N/A
				expect(html).toContain('N/A');
			});

			it('joins parts with middle dot separator', () => {
				const tab = createMockTab({
					usageStats: {
						inputTokens: 500,
						outputTokens: 300,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.05,
						contextWindow: 200000,
					},
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// Parts joined with ' \u00b7 ' (middle dot)
				expect(html).toMatch(/500 input .+ 300 output .+ \$0\.0500/);
			});
		});

		describe('HTML escaping', () => {
			it('escapes special characters in tab name', () => {
				const tab = createMockTab({ name: 'Tab <script>alert("xss")</script>' });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).not.toContain('<script>alert("xss")</script>');
				expect(html).toContain('&lt;script&gt;');
				expect(html).toContain('&quot;xss&quot;');
			});

			it('escapes special characters in session name', () => {
				const session = { ...mockSession, name: 'Session <b>bold</b>' };
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, session, mockTheme);

				expect(html).toContain('Session &lt;b&gt;bold&lt;/b&gt;');
			});

			it('escapes special characters in working directory', () => {
				const session = { ...mockSession, cwd: '/path/with "quotes" & <brackets>' };
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, session, mockTheme);

				expect(html).toContain('&amp;');
				expect(html).toContain('&lt;brackets&gt;');
				expect(html).toContain('&quot;quotes&quot;');
			});

			it('escapes special characters in tool type', () => {
				const session = { ...mockSession, toolType: 'agent<type>' };
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, session, mockTheme);

				expect(html).toContain('agent&lt;type&gt;');
			});

			it('escapes ampersands correctly', () => {
				const tab = createMockTab({ name: 'Tab & More' });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Tab &amp; More');
			});

			it('escapes single quotes', () => {
				const tab = createMockTab({ name: "Tab's Name" });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Tab&#039;s Name');
			});

			it('escapes source labels in messages', () => {
				// Source labels are already fixed strings (User, AI, etc.),
				// but the escapeHtml call wraps them - verify it does not break
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('User');
			});
		});

		describe('session details section', () => {
			it('includes agent type in details', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Agent');
				expect(html).toContain('claude-code');
			});

			it('includes working directory in details', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Working Directory');
				expect(html).toContain('/home/user/project');
			});

			it('includes session name in details', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Session Name');
				expect(html).toContain('My Session');
			});

			it('includes created timestamp in details', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Created');
			});

			it('includes usage stats in details', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Usage');
			});

			it('includes session ID when agentSessionId is provided', () => {
				const tab = createMockTab({
					agentSessionId: 'session-abc-def-123',
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Session ID');
				expect(html).toContain('session-abc-def-123');
			});

			it('omits session ID row when agentSessionId is null', () => {
				const tab = createMockTab({ agentSessionId: null });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// Session ID label should not appear
				expect(html).not.toContain('>Session ID<');
			});

			it('renders details section with correct CSS classes', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="section-title"');
				expect(html).toContain('class="info-grid"');
				expect(html).toContain('class="info-label"');
				expect(html).toContain('class="info-value"');
			});
		});

		describe('markdown content rendering', () => {
			it('passes message text through marked for rendering', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'ai', text: '**bold text**' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// Our mock wraps in <p> tags
				expect(html).toContain('<p>**bold text**</p>');
			});

			it('renders content inside message-content div', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Some content' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="message-content"');
				expect(html).toContain('<p>Some content</p>');
			});
		});

		describe('branding section', () => {
			it('includes Maestro branding section', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="branding"');
				expect(html).toContain('Maestro');
			});

			it('includes tagline about multi-agent orchestration', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Multi-agent orchestration');
			});

			it('includes runmaestro.ai link', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('href="https://runmaestro.ai"');
				expect(html).toContain('runmaestro.ai');
			});

			it('includes GitHub link', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('href="https://github.com/RunMaestro/Maestro"');
				expect(html).toContain('GitHub');
			});

			it('includes Maestro logo image', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="branding-logo"');
				expect(html).toContain('data:image/png;base64,');
			});
		});

		describe('footer', () => {
			it('includes Maestro attribution with runmaestro.ai link', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="footer"');
				expect(html).toContain('Exported from');
				expect(html).toContain('href="https://runmaestro.ai"');
			});

			it('includes theme name in footer', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="footer-theme"');
				expect(html).toContain('Theme: Dracula');
			});
		});

		describe('edge cases', () => {
			it('handles empty logs array', () => {
				const tab = createMockTab({ logs: [] });
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('</html>');
			});

			it('handles unicode characters in messages', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello! Cafe ☕ 日本語' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Cafe');
				expect(html).toContain('☕');
				expect(html).toContain('日本語');
			});

			it('handles very long messages', () => {
				const longContent = 'A'.repeat(10000);
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'ai', text: longContent })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(longContent);
			});

			it('handles mixed source types in same conversation', () => {
				const tab = createMockTab({
					logs: [
						createLogEntry({ source: 'user', text: 'Question' }),
						createLogEntry({ source: 'thinking', text: 'Reasoning' }),
						createLogEntry({ source: 'tool', text: 'Tool call' }),
						createLogEntry({ source: 'ai', text: 'Answer' }),
						createLogEntry({ source: 'error', text: 'Error' }),
						createLogEntry({ source: 'system', text: 'System' }),
						createLogEntry({ source: 'stderr', text: 'Stderr' }),
						createLogEntry({ source: 'stdout', text: 'Stdout' }),
					],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
				// All 8 messages should be rendered
				const messageMatches = html.match(/class="message /g);
				expect(messageMatches).toHaveLength(8);
			});

			it('handles tab with all optional fields missing', () => {
				const tab = createMockTab({
					name: null,
					agentSessionId: null,
					usageStats: undefined,
					logs: [],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('New Session');
			});
		});

		describe('CSS responsiveness', () => {
			it('includes mobile media query', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('@media (max-width: 640px)');
			});

			it('includes print media query', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('@media print');
			});
		});

		describe('conversation section', () => {
			it('includes conversation section header', () => {
				const tab = createMockTab();
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Conversation');
			});

			it('renders messages container', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="messages"');
			});

			it('includes message timestamps', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="message-time"');
			});

			it('includes message headers with from label', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'user', text: 'Hello' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('class="message-header"');
				expect(html).toContain('class="message-from"');
			});
		});

		describe('stderr source handling', () => {
			it('renders stderr with error color', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'stderr', text: 'stderr output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.error}"`);
			});

			it('labels stderr as Error', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'stderr', text: 'stderr output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain('Error');
			});
		});

		describe('stdout source handling', () => {
			it('renders stdout with success color', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'stdout', text: 'stdout output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				expect(html).toContain(`style="color: ${mockTheme.colors.success}"`);
			});

			it('labels stdout as AI', () => {
				const tab = createMockTab({
					logs: [createLogEntry({ source: 'stdout', text: 'stdout output' })],
				});
				const html = generateTabExportHtml(tab, mockSession, mockTheme);

				// stdout gets labeled as 'AI'
				expect(html).toContain('>AI<');
			});
		});
	});
});

// ===== from src/__tests__/renderer/utils/terminalKeys.test.ts =====

describe('TERMINAL_KEY_SEQUENCES', () => {
	it('maps each key bar button to the raw PTY byte sequence a hardware key would send', () => {
		expect(TERMINAL_KEY_SEQUENCES.esc).toBe('\x1b');
		expect(TERMINAL_KEY_SEQUENCES.tab).toBe('\t');
		expect(TERMINAL_KEY_SEQUENCES.enter).toBe('\r');
		expect(TERMINAL_KEY_SEQUENCES.up).toBe('\x1b[A');
		expect(TERMINAL_KEY_SEQUENCES.down).toBe('\x1b[B');
		expect(TERMINAL_KEY_SEQUENCES.left).toBe('\x1b[D');
		expect(TERMINAL_KEY_SEQUENCES.right).toBe('\x1b[C');
	});
});

describe('toControlChar', () => {
	it('folds lowercase letters onto their Ctrl code (\\x01-\\x1a)', () => {
		expect(toControlChar('a')).toBe('\x01');
		expect(toControlChar('c')).toBe('\x03'); // Ctrl-C
		expect(toControlChar('d')).toBe('\x04'); // Ctrl-D
		expect(toControlChar('z')).toBe('\x1a');
	});

	it('treats uppercase letters identically to lowercase', () => {
		expect(toControlChar('C')).toBe('\x03');
		expect(toControlChar('Z')).toBe('\x1a');
	});

	it('maps the classic control symbols @ [ \\ ] ^ _', () => {
		expect(toControlChar('@')).toBe('\x00'); // Ctrl-@ = NUL
		expect(toControlChar('[')).toBe('\x1b'); // Ctrl-[ = ESC
		expect(toControlChar('\\')).toBe('\x1c');
		expect(toControlChar(']')).toBe('\x1d');
		expect(toControlChar('^')).toBe('\x1e');
		expect(toControlChar('_')).toBe('\x1f'); // Ctrl-_
	});

	it('maps ? to DEL and space to NUL', () => {
		expect(toControlChar('?')).toBe('\x7f');
		expect(toControlChar(' ')).toBe('\x00');
	});

	it('passes through digits and other single chars with no control code', () => {
		expect(toControlChar('1')).toBe('1');
		expect(toControlChar('!')).toBe('!');
	});

	it('leaves multi-byte input untouched (paste / IME / escape sequences)', () => {
		expect(toControlChar('hello')).toBe('hello');
		expect(toControlChar('\x1b[A')).toBe('\x1b[A');
		expect(toControlChar('')).toBe('');
	});
});

// ===== from src/__tests__/renderer/utils/textareaSizing.test.ts =====

function setViewportHeight(height: number) {
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('textareaSizing', () => {
	beforeEach(() => {
		setViewportHeight(900);
	});

	describe('normalizeTextareaHeight', () => {
		it('rounds finite positive numbers', () => {
			expect(normalizeTextareaHeight(120.4)).toBe(120);
			expect(normalizeTextareaHeight(120.6)).toBe(121);
		});

		it('rejects junk values', () => {
			for (const value of [0, -10, NaN, Infinity, '200', null, undefined, {}]) {
				expect(normalizeTextareaHeight(value)).toBeNull();
			}
		});
	});

	describe('sanitizeTextareaHeights', () => {
		it('keeps valid entries and drops the rest', () => {
			expect(
				sanitizeTextareaHeights({
					good: 240,
					rounded: 199.7,
					zero: 0,
					negative: -5,
					text: '300',
				})
			).toEqual({ good: 240, rounded: 200 });
		});

		it('returns an empty map for non-objects', () => {
			expect(sanitizeTextareaHeights(null)).toEqual({});
			expect(sanitizeTextareaHeights([240])).toEqual({});
			expect(sanitizeTextareaHeights('240')).toEqual({});
		});
	});

	describe('clampTextareaHeight', () => {
		it('honors the declared minimum', () => {
			expect(clampTextareaHeight(40, { minHeight: 100 })).toBe(100);
		});

		it('caps at the declared maximum', () => {
			expect(clampTextareaHeight(900, { minHeight: 100, maxHeight: 400 })).toBe(400);
		});

		it('caps at the viewport even without a declared maximum', () => {
			setViewportHeight(600);
			// Viewport minus padding on both sides is the tighter of the two caps.
			expect(clampTextareaHeight(5000, { minHeight: 100 })).toBe(536);
		});

		it('never returns a minimum larger than the viewport allows', () => {
			setViewportHeight(300);
			expect(clampTextareaHeight(10, { minHeight: 5000 })).toBe(236);
		});
	});

	describe('resolveTextareaHeight', () => {
		it('prefers the saved height', () => {
			expect(resolveTextareaHeight({ savedHeight: 250, defaultHeight: 100 })).toBe(250);
		});

		it('falls back to the default when nothing is saved', () => {
			expect(resolveTextareaHeight({ savedHeight: undefined, defaultHeight: 100 })).toBe(100);
		});

		it('ignores a corrupt saved height', () => {
			expect(resolveTextareaHeight({ savedHeight: -20, defaultHeight: 100 })).toBe(100);
		});

		it('returns null when nothing is saved and no default is declared', () => {
			expect(resolveTextareaHeight({ savedHeight: undefined })).toBeNull();
		});

		it('clamps a saved height that no longer fits the viewport', () => {
			setViewportHeight(500);
			expect(resolveTextareaHeight({ savedHeight: 2000, minHeight: 100 })).toBe(436);
		});
	});
});

describe('resizeTextareaToContent', () => {
	it('resizes to content height capped by max height', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 220, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('176px');
	});

	it('resizes to exact content height below cap', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 80, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('80px');
	});

	it('preserves scroll position across the auto-height toggle', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true });
		textarea.scrollTop = 120;

		resizeTextareaToContent(textarea, 176);

		expect(textarea.scrollTop).toBe(120);
	});
});

describe('scrollTextareaToCaretEnd', () => {
	it('scrolls the textarea to the bottom when the caret is at the end', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.length,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(240);
	});

	it('leaves scroll untouched when the caret is mid-way through the final logical line', () => {
		const textarea = document.createElement('textarea');
		// Regression for the soft-wrap edge case: a long final logical line can wrap
		// across several visual rows past the height cap. A caret before the trailing
		// characters (e.g. an inserted mention) belongs to an earlier visual row, so
		// snapping to scrollHeight would scroll it out of view. The gate keys off the
		// true end of the value, not the final logical line, precisely to avoid that.
		textarea.value = 'first\nsecond\nlast line';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.indexOf('last line') + 4,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('leaves scroll untouched for mid-text typing', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello world';
		textarea.scrollTop = 30;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(30);
	});
});

// ===== from src/__tests__/renderer/utils/thinkingItems.test.ts =====

describe('buildThinkingItems', () => {
	it('returns no items when nothing is busy', () => {
		const sessions = [
			createMockSession({ id: 'a', state: 'idle' }),
			createMockSession({ id: 'b', state: 'idle' }),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('emits one item per busy AI tab', () => {
		const busyTabs = [
			createMockAITab({ id: 't1', state: 'busy' }),
			createMockAITab({ id: 't2', state: 'busy' }),
			createMockAITab({ id: 't3', state: 'idle' }),
		];
		const sessions = [
			createMockSession({ id: 'a', state: 'busy', busySource: 'ai', aiTabs: busyTabs }),
		];
		const items = buildThinkingItems(sessions);
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.tab?.id)).toEqual(['t1', 't2']);
		expect(items.every((i) => i.session.id === 'a')).toBe(true);
	});

	it('falls back to a legacy (tab: null) item when busy with no tab-level tracking', () => {
		const sessions = [createMockSession({ id: 'a', state: 'busy', busySource: 'ai', aiTabs: [] })];
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: null }]);
	});

	it('does NOT emit a legacy item when the session is busy via terminal, not AI', () => {
		const sessions = [
			createMockSession({ id: 'a', state: 'busy', busySource: 'terminal', aiTabs: [] }),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('includes orphaned (closed-but-still-thinking) tabs', () => {
		const orphan = createMockAITab({ id: 'orphan', state: 'busy' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'idle',
				orphanedThinkingTabs: [orphan],
			}),
		];
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: orphan }]);
	});

	it('does not list a closed tab parked idle by a held queued item', () => {
		// Regression: closing a tab that owns a HELD message parks it in
		// orphanedThinkingTabs (idle) as a dispatch target. No process runs for
		// it, yet the pill showed it as "Thinking..." until the item was removed.
		const parked = createMockAITab({ id: 'closed', state: 'idle' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'idle',
				aiTabs: [createMockAITab({ id: 't1', state: 'idle' })],
				orphanedThinkingTabs: [parked],
				executionQueue: [
					{
						id: 'q1',
						timestamp: 1,
						tabId: 'closed',
						type: 'message',
						text: 'later',
						paused: true,
					},
				],
			}),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('keeps the legacy fallback when the only orphan is parked idle', () => {
		const parked = createMockAITab({ id: 'closed', state: 'idle' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockAITab({ id: 't1', state: 'idle' })],
				orphanedThinkingTabs: [parked],
			}),
		];
		expect(buildThinkingItems(sessions)).toEqual([{ session: sessions[0], tab: null }]);
	});

	it('skips the legacy fallback when only orphaned tabs are present (no double count)', () => {
		const orphan = createMockAITab({ id: 'orphan', state: 'busy' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [],
				orphanedThinkingTabs: [orphan],
			}),
		];
		// One entry for the orphan, NOT an extra legacy {tab: null} entry.
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: orphan }]);
	});

	describe('window scoping (ownsSession gate)', () => {
		const owned = createMockSession({
			id: 'owned',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'owned-tab', state: 'busy' })],
		});
		const remote = createMockSession({
			id: 'remote',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'remote-tab', state: 'busy' })],
		});
		const sessions = [owned, remote];

		it('includes every session when no ownership predicate is given', () => {
			const items = buildThinkingItems(sessions);
			expect(items.map((i) => i.session.id)).toEqual(['owned', 'remote']);
		});

		it('drops agents this window does not own', () => {
			const ownsSession = (id: string) => id === 'owned';
			const items = buildThinkingItems(sessions, ownsSession);
			expect(items).toHaveLength(1);
			expect(items[0].session.id).toBe('owned');
		});

		it('drops orphaned thinking tabs for agents owned by another window', () => {
			const remoteOrphan = createMockSession({
				id: 'remote',
				state: 'idle',
				orphanedThinkingTabs: [createMockAITab({ id: 'remote-orphan', state: 'busy' })],
			});
			const ownsSession = (id: string) => id === 'owned';
			const items = buildThinkingItems([owned, remoteOrphan], ownsSession);
			expect(items.map((i) => i.session.id)).toEqual(['owned']);
		});

		it('returns nothing when this window owns none of the busy agents', () => {
			const ownsSession = () => false;
			expect(buildThinkingItems(sessions, ownsSession)).toEqual([]);
		});
	});
});
