// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/agents/agent-completeness.test.ts
//   - src/__tests__/main/agents/capabilities.test.ts
//   - src/__tests__/main/agents/capability-snapshot.test.ts
//   - src/__tests__/main/agents/claude-account-identity.test.ts
//   - src/__tests__/main/agents/claude-mode-selector.test.ts
//   - src/__tests__/main/agents/codex-config.test.ts

import {
	AGENT_CAPABILITIES,
	AGENT_DEFINITIONS,
	AgentCapabilities,
	DEFAULT_CAPABILITIES,
	getAgentCapabilities,
	hasCapability,
} from '../../../main/agents';
import { CapabilitySnapshotManager } from '../../../main/agents/capability-snapshot';
import { readClaudeAccountIdentity } from '../../../main/agents/claude-account-identity';
import { LIMIT_THRESHOLD_PERCENT, selectMode } from '../../../main/agents/claude-mode-selector';
import type { SelectModeInput, UsageSnapshot } from '../../../main/agents/claude-mode-selector';
import {
	getCodexHome,
	getCodexPromptDirs,
	getCodexSkillDirs,
	parseCodexMarkdownDoc,
} from '../../../main/agents/codex-config';
import { clearStorageRegistry, getSessionStorage } from '../../../main/agents/session-storage';
import { getErrorPatterns, getOutputParser, initializeOutputParsers } from '../../../main/parsers';
import { initializeSessionStorages } from '../../../main/storage';
import type {
	AgentCapabilitiesSnapshotMap,
	SnapshotUpdatedPayload,
} from '../../../shared/agentCapabilities';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	AGENT_AUTOSELECT_ORDER,
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	getAgentDisplayName,
	getAgentLoginCommand,
} from '../../../shared/agentMetadata';
import { createAgentRegistry } from '../../../shared/plugins/agent-registry';
import * as os from 'os';
import path from 'path';
import * as path_1 from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
	captureException: vi.fn(),
}));
const { readFileMock, loggerWarnMock } = vi.hoisted(() => ({
	readFileMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const promises = { ...actual.promises, readFile: readFileMock };
	return { ...actual, promises, default: { ...actual, promises } };
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: loggerWarnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ===== from src/__tests__/main/agents/agent-completeness.test.ts =====

describe('Agent Completeness', () => {
	beforeAll(() => {
		initializeOutputParsers();
		clearStorageRegistry();
		initializeSessionStorages();
	});

	describe('AGENT_IDS ↔ AGENT_DEFINITIONS consistency', () => {
		it('every agent in AGENT_DEFINITIONS should have an ID in AGENT_IDS', () => {
			for (const def of AGENT_DEFINITIONS) {
				expect(
					AGENT_IDS.includes(def.id as (typeof AGENT_IDS)[number]),
					`Agent "${def.id}" is in AGENT_DEFINITIONS but not in AGENT_IDS (shared/agentIds.ts)`
				).toBe(true);
			}
		});

		it('every ID in AGENT_IDS should have a definition in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const id of AGENT_IDS) {
				expect(
					definedIds.includes(id),
					`Agent ID "${id}" is in AGENT_IDS but not in AGENT_DEFINITIONS (agents/definitions.ts)`
				).toBe(true);
			}
		});
	});

	describe('per-agent completeness', () => {
		for (const def of AGENT_DEFINITIONS) {
			describe(`${def.id}`, () => {
				it('has capabilities defined in AGENT_CAPABILITIES', () => {
					expect(
						AGENT_CAPABILITIES[def.id],
						`Agent "${def.id}" is missing from AGENT_CAPABILITIES (agents/capabilities.ts)`
					).toBeDefined();
				});

				it('has all required capability fields', () => {
					const caps = AGENT_CAPABILITIES[def.id];
					if (!caps) return; // Covered by previous test

					const requiredBooleanFields = [
						'supportsResume',
						'supportsReadOnlyMode',
						'supportsJsonOutput',
						'supportsSessionId',
						'supportsImageInput',
						'supportsImageInputOnResume',
						'supportsSlashCommands',
						'supportsSessionStorage',
						'supportsCostTracking',
						'supportsUsageStats',
						'supportsBatchMode',
						'supportsStreaming',
						'supportsResultMessages',
						'supportsModelSelection',
						'requiresPromptToStart',
						'supportsStreamJsonInput',
						'supportsPromptViaStdin',
						'supportsThinkingDisplay',
						'supportsContextMerge',
						'supportsContextExport',
						'supportsAdditionalDirectories',
					];

					for (const field of requiredBooleanFields) {
						expect(
							typeof (caps as Record<string, unknown>)[field],
							`Agent "${def.id}" is missing capability field "${field}"`
						).toBe('boolean');
					}
				});

				// The capability boolean and the arg builder are two halves of one
				// feature: the boolean drives UI copy ("enforced by the provider" vs
				// "instructions only") while the builder produces the actual flags.
				// Let them drift and the UI promises enforcement that never ships.
				it('declares additionalDirArgs iff supportsAdditionalDirectories', () => {
					const caps = getAgentCapabilities(def.id);

					if (caps.supportsAdditionalDirectories) {
						expect(
							typeof def.additionalDirArgs,
							`Agent "${def.id}" has supportsAdditionalDirectories=true but no additionalDirArgs() in agents/definitions.ts, so its grants would silently never reach the CLI`
						).toBe('function');
					} else {
						expect(
							def.additionalDirArgs,
							`Agent "${def.id}" defines additionalDirArgs() but supportsAdditionalDirectories=false, so the args are built and the UI still tells the user nothing is enforced`
						).toBeUndefined();
					}
				});

				it('emits no directory args when the agent has no grants', () => {
					// Guards the common spawn case: an agent with an empty grant list
					// must not gain a stray flag (a bare `--add-dir` with no value would
					// eat the next arg, which on several paths is the prompt).
					expect(def.additionalDirArgs?.([]) ?? []).toEqual([]);
				});

				it('has output parser if supportsJsonOutput', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsJsonOutput) {
						expect(
							getOutputParser(def.id),
							`Agent "${def.id}" has supportsJsonOutput=true but no output parser registered`
						).not.toBeNull();
					}
				});

				it('has session storage if supportsSessionStorage', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsSessionStorage) {
						expect(
							getSessionStorage(def.id),
							`Agent "${def.id}" has supportsSessionStorage=true but no session storage registered`
						).not.toBeNull();
					}
				});

				it('has error patterns if has output parser', () => {
					const parser = getOutputParser(def.id);
					if (parser) {
						const patterns = getErrorPatterns(def.id);
						expect(
							Object.keys(patterns).length,
							`Agent "${def.id}" has an output parser but no error patterns registered`
						).toBeGreaterThan(0);
					}
				});
			});
		}
	});

	describe('provider picker registration', () => {
		it('every agent id has a picker decision, shown or explicitly withheld', () => {
			for (const agentId of AGENT_IDS) {
				expect(
					Object.prototype.hasOwnProperty.call(AGENT_PICKER_META, agentId),
					`Agent "${agentId}" has no entry in AGENT_PICKER_META. Add presentation ` +
						'metadata to offer it in the pickers, or null to withhold it.'
				).toBe(true);
			}
		});

		it('offers providers alphabetically by display name', () => {
			// One predictable order across the New Agent modal, the wizard tile strip
			// and the Group Chat moderator dropdown, so a provider is where the user
			// expects it no matter which surface they open.
			const names = PICKABLE_AGENT_IDS.map((id) => getAgentDisplayName(id));
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		});

		it('auto-selects a real pickable agent rather than whatever sorts first', () => {
			for (const agentId of AGENT_AUTOSELECT_ORDER) {
				expect(
					PICKABLE_AGENT_IDS.includes(agentId),
					`Auto-select preference "${agentId}" is not a pickable provider`
				).toBe(true);
			}
		});

		it('every pickable agent is a real, non-hidden definition', () => {
			for (const agentId of PICKABLE_AGENT_IDS) {
				const def = AGENT_DEFINITIONS.find((d) => d.id === agentId);
				expect(def, `Pickable agent "${agentId}" has no definition`).toBeDefined();
				expect(def?.hidden, `Pickable agent "${agentId}" is hidden`).toBeFalsy();
			}
		});

		// Providers that hold no credentials of their own, so `null` from
		// getAgentLoginCommand is the correct answer rather than a missing entry.
		// Pi and Oh My Pi are harnesses over a provider the user configures
		// elsewhere; Hermes ships no login flow. Adding an id here is a deliberate
		// claim that the agent cannot be logged in to, not a way to silence a gap.
		const CREDENTIALLESS_AGENTS = new Set(['hermes', 'pi', 'omp']);

		it('every pickable agent can be re-authenticated from the UI', () => {
			// A provider offered in a picker whose auth expires needs a way back in.
			// An earlier version of this test skipped a null command outright, which
			// let a genuinely missing entry pass as if it were credentialless.
			for (const agentId of PICKABLE_AGENT_IDS) {
				const login = getAgentLoginCommand(agentId);

				if (CREDENTIALLESS_AGENTS.has(agentId)) {
					expect(
						login,
						`Agent "${agentId}" is listed as credentialless but declares a login command. ` +
							'Remove it from CREDENTIALLESS_AGENTS.'
					).toBeNull();
					continue;
				}

				expect(
					login,
					`Agent "${agentId}" is pickable but has no login command. Add one to ` +
						'AGENT_LOGIN_COMMANDS, or add the id to CREDENTIALLESS_AGENTS if it ' +
						'genuinely carries no credentials.'
				).not.toBeNull();
				expect(login?.binary?.trim(), `Agent "${agentId}" has an empty login binary`).toBeTruthy();
				expect(
					typeof login?.args,
					`Agent "${agentId}" must declare args (empty string when the bare binary is the flow)`
				).toBe('string');
			}
		});
	});

	describe('no orphaned capabilities', () => {
		it('every agent in AGENT_CAPABILITIES should be in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const agentId of Object.keys(AGENT_CAPABILITIES)) {
				expect(
					definedIds.includes(agentId),
					`Agent "${agentId}" is in AGENT_CAPABILITIES but not in AGENT_DEFINITIONS`
				).toBe(true);
			}
		});
	});

	// Runtime (plugin) agents are intentionally NOT subject to the static
	// completeness checks above. They are known to the registry but absent from
	// the compile-time tables, and that separation is the relaxation that lets
	// plugins add agents without touching first-party type exhaustiveness.
	describe('runtime agents live outside the static core', () => {
		it('a registered runtime agent is known but is not a built-in', () => {
			const reg = createAgentRegistry([
				{
					id: 'com.acme/bot',
					localId: 'bot',
					pluginId: 'com.acme',
					displayName: 'Bot',
					binaryName: 'bot',
					baseArgs: [],
					capabilities: {},
				},
			]);
			expect(reg.isKnown('com.acme/bot')).toBe(true);
			expect(reg.isBuiltIn('com.acme/bot')).toBe(false);
			// It must NOT leak into the static built-in structures.
			expect(AGENT_IDS.includes('com.acme/bot' as (typeof AGENT_IDS)[number])).toBe(false);
			expect(AGENT_DEFINITIONS.map((d) => d.id).includes('com.acme/bot')).toBe(false);
		});

		it('every built-in id is reported as built-in by the registry', () => {
			const reg = createAgentRegistry([]);
			for (const id of AGENT_IDS) {
				expect(reg.isBuiltIn(id), `registry should treat "${id}" as built-in`).toBe(true);
			}
		});
	});
});

// ===== from src/__tests__/main/agents/capabilities.test.ts =====

describe('agent-capabilities', () => {
	describe('AgentCapabilities interface', () => {
		it('should have all required capability fields', () => {
			const capabilities: AgentCapabilities = {
				...DEFAULT_CAPABILITIES,
			};

			expect(capabilities.supportsResume).toBe(false);
			expect(capabilities.supportsReadOnlyMode).toBe(false);
			expect(capabilities.supportsJsonOutput).toBe(false);
			expect(capabilities.supportsSessionId).toBe(false);
			expect(capabilities.supportsImageInput).toBe(false);
			expect(capabilities.supportsImageInputOnResume).toBe(false);
			expect(capabilities.supportsSlashCommands).toBe(false);
			expect(capabilities.supportsSessionStorage).toBe(false);
			expect(capabilities.supportsCostTracking).toBe(false);
			expect(capabilities.supportsUsageStats).toBe(false);
			expect(capabilities.supportsBatchMode).toBe(false);
			expect(capabilities.supportsStreaming).toBe(false);
			expect(capabilities.supportsResultMessages).toBe(false);
			expect(capabilities.supportsWizard).toBe(false);
			expect(capabilities.supportsGroupChatModeration).toBe(false);
			expect(capabilities.usesJsonLineOutput).toBe(false);
			expect(capabilities.usesCombinedContextWindow).toBe(false);
		});
	});

	describe('DEFAULT_CAPABILITIES', () => {
		it('should have all capabilities set to false', () => {
			expect(DEFAULT_CAPABILITIES.supportsResume).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsReadOnlyMode).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsJsonOutput).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSessionId).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsImageInput).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsImageInputOnResume).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSlashCommands).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSessionStorage).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsCostTracking).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsUsageStats).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsBatchMode).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsStreaming).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsResultMessages).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsWizard).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsGroupChatModeration).toBe(false);
			expect(DEFAULT_CAPABILITIES.usesJsonLineOutput).toBe(false);
			expect(DEFAULT_CAPABILITIES.usesCombinedContextWindow).toBe(false);
		});

		it('should be a conservative default (all false)', () => {
			const allFalse = Object.values(DEFAULT_CAPABILITIES).every((v) => v === false);
			expect(allFalse).toBe(true);
		});
	});

	describe('AGENT_CAPABILITIES', () => {
		it('should have capabilities for claude-code', () => {
			const capabilities = AGENT_CAPABILITIES['claude-code'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsSlashCommands).toBe(true);
			expect(capabilities.supportsSessionStorage).toBe(true);
			expect(capabilities.supportsCostTracking).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
			expect(capabilities.imageResumeMode).toBeUndefined();
		});

		it('should have capabilities for terminal', () => {
			const capabilities = AGENT_CAPABILITIES['terminal'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(false);
			expect(capabilities.supportsStreaming).toBe(true);
			// Terminal is not an AI agent, should have minimal capabilities
			expect(capabilities.supportsJsonOutput).toBe(false);
			expect(capabilities.supportsCostTracking).toBe(false);
		});

		it('should have capabilities for codex', () => {
			const capabilities = AGENT_CAPABILITIES['codex'];
			expect(capabilities).toBeDefined();
			// Verified capabilities based on CLI testing (v0.111.0+)
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			// Custom skills/prompts read off disk and expanded renderer-side.
			expect(capabilities.supportsSlashCommands).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(false);
			expect(capabilities.imageResumeMode).toBe('prompt-embed');
		});

		it('should have capabilities for gemini-cli', () => {
			const capabilities = AGENT_CAPABILITIES['gemini-cli'];
			expect(capabilities).toBeDefined();
			// Gemini supports multimodal
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
		});

		it('should have capabilities for qwen3-coder', () => {
			const capabilities = AGENT_CAPABILITIES['qwen3-coder'];
			expect(capabilities).toBeDefined();
			// Local/plan model - no cost tracking
			expect(capabilities.supportsCostTracking).toBe(false);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsModelSelection).toBe(true);
		});

		it('should have capabilities for opencode', () => {
			const capabilities = AGENT_CAPABILITIES['opencode'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
		});

		it('should have verified capabilities for copilot', () => {
			const capabilities = AGENT_CAPABILITIES['copilot-cli'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsImageInputOnResume).toBe(true);
			expect(capabilities.supportsSlashCommands).toBe(true);
			expect(capabilities.supportsSessionStorage).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
			expect(capabilities.supportsThinkingDisplay).toBe(true);
			expect(capabilities.supportsContextMerge).toBe(true);
			expect(capabilities.supportsContextExport).toBe(true);
			expect(capabilities.supportsWizard).toBe(true);
			expect(capabilities.supportsGroupChatModeration).toBe(true);
		});

		it('should expose Pi capabilities backed by its documented CLI contract', () => {
			const capabilities = AGENT_CAPABILITIES.pi;

			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsImageInputOnResume).toBe(true);
			expect(capabilities.supportsCostTracking).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
			expect(capabilities.supportsThinkingDisplay).toBe(true);
			expect(capabilities.usesJsonLineOutput).toBe(true);
		});

		it('should expose Oh My Pi capabilities backed by its JSON event protocol', () => {
			const capabilities = AGENT_CAPABILITIES.omp;

			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsModelSelection).toBe(true);
			expect(capabilities.supportsCostTracking).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
			expect(capabilities.supportsThinkingDisplay).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.usesJsonLineOutput).toBe(true);
		});

		it('should define capabilities for all known agents', () => {
			const knownAgents = [
				'claude-code',
				'terminal',
				'codex',
				'gemini-cli',
				'qwen3-coder',
				'opencode',
				'factory-droid',
				'copilot-cli',
				'omp',
			];

			for (const agentId of knownAgents) {
				expect(AGENT_CAPABILITIES[agentId]).toBeDefined();
				// Each should have all capability fields
				expect(typeof AGENT_CAPABILITIES[agentId].supportsResume).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsReadOnlyMode).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsJsonOutput).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSessionId).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsImageInput).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsImageInputOnResume).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSlashCommands).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSessionStorage).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsCostTracking).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsUsageStats).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsBatchMode).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsStreaming).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsResultMessages).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsWizard).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsGroupChatModeration).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].usesJsonLineOutput).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].usesCombinedContextWindow).toBe('boolean');
			}
		});
	});

	describe('getAgentCapabilities', () => {
		it('should return capabilities for known agents', () => {
			const capabilities = getAgentCapabilities('claude-code');
			expect(capabilities).toEqual(AGENT_CAPABILITIES['claude-code']);
		});

		it('should return default capabilities for unknown agents', () => {
			const capabilities = getAgentCapabilities('unknown-agent');
			expect(capabilities).toEqual(DEFAULT_CAPABILITIES);
		});

		it('should return a copy of default capabilities for unknown agents', () => {
			const capabilities1 = getAgentCapabilities('unknown-agent-1');
			const capabilities2 = getAgentCapabilities('unknown-agent-2');

			// Should be equal but not the same reference
			expect(capabilities1).toEqual(capabilities2);
			expect(capabilities1).not.toBe(capabilities2);
		});

		it('should return correct capabilities for each agent type', () => {
			expect(getAgentCapabilities('claude-code').supportsResume).toBe(true);
			expect(getAgentCapabilities('terminal').supportsResume).toBe(false);
			expect(getAgentCapabilities('opencode').supportsResume).toBe(true);
		});
	});

	describe('hasCapability', () => {
		it('should return true for supported capabilities', () => {
			expect(hasCapability('claude-code', 'supportsResume')).toBe(true);
			expect(hasCapability('claude-code', 'supportsImageInput')).toBe(true);
			expect(hasCapability('claude-code', 'supportsJsonOutput')).toBe(true);
		});

		it('should return false for unsupported capabilities', () => {
			expect(hasCapability('terminal', 'supportsResume')).toBe(false);
			expect(hasCapability('terminal', 'supportsJsonOutput')).toBe(false);
			expect(hasCapability('openai-codex', 'supportsResume')).toBe(false);
		});

		it('should return false for unknown agents', () => {
			expect(hasCapability('unknown-agent', 'supportsResume')).toBe(false);
			expect(hasCapability('unknown-agent', 'supportsStreaming')).toBe(false);
		});

		it('should work for all capability types', () => {
			const capabilityKeys = Object.keys(DEFAULT_CAPABILITIES) as (keyof AgentCapabilities)[];

			for (const key of capabilityKeys) {
				// Should not throw for any capability
				expect(() => hasCapability('claude-code', key)).not.toThrow();
				// Result should be a boolean
				expect(typeof hasCapability('claude-code', key)).toBe('boolean');
			}
		});

		it('marks omp as unable to read the prompt from stdin', () => {
			// omp takes the prompt positionally: piping it to stdin makes the run
			// exit 0 with no output, which is why prompt delivery is capability-gated.
			expect(hasCapability('omp', 'supportsPromptViaStdin')).toBe(false);
			expect(hasCapability('claude-code', 'supportsPromptViaStdin')).toBe(true);
			expect(hasCapability('codex', 'supportsPromptViaStdin')).toBe(true);
			expect(hasCapability('opencode', 'supportsPromptViaStdin')).toBe(true);
			// Unknown agents fall back to argv delivery (loud failure over silent).
			expect(hasCapability('unknown-agent', 'supportsPromptViaStdin')).toBe(false);
		});

		it('should return correct values for new capability flags', () => {
			// supportsWizard
			expect(hasCapability('claude-code', 'supportsWizard')).toBe(true);
			expect(hasCapability('codex', 'supportsWizard')).toBe(true);
			expect(hasCapability('opencode', 'supportsWizard')).toBe(true);
			expect(hasCapability('factory-droid', 'supportsWizard')).toBe(true);
			expect(hasCapability('copilot-cli', 'supportsWizard')).toBe(true);
			expect(hasCapability('grok', 'supportsWizard')).toBe(true);
			expect(hasCapability('terminal', 'supportsWizard')).toBe(false);

			// supportsGroupChatModeration
			expect(hasCapability('claude-code', 'supportsGroupChatModeration')).toBe(true);
			expect(hasCapability('codex', 'supportsGroupChatModeration')).toBe(true);
			expect(hasCapability('opencode', 'supportsGroupChatModeration')).toBe(true);
			expect(hasCapability('copilot-cli', 'supportsGroupChatModeration')).toBe(true);
			expect(hasCapability('factory-droid', 'supportsGroupChatModeration')).toBe(true);
			expect(hasCapability('terminal', 'supportsGroupChatModeration')).toBe(false);

			// usesJsonLineOutput
			expect(hasCapability('claude-code', 'usesJsonLineOutput')).toBe(false);
			expect(hasCapability('codex', 'usesJsonLineOutput')).toBe(true);
			expect(hasCapability('opencode', 'usesJsonLineOutput')).toBe(true);
			expect(hasCapability('factory-droid', 'usesJsonLineOutput')).toBe(true);
			expect(hasCapability('terminal', 'usesJsonLineOutput')).toBe(false);

			// usesCombinedContextWindow
			expect(hasCapability('codex', 'usesCombinedContextWindow')).toBe(true);
			expect(hasCapability('claude-code', 'usesCombinedContextWindow')).toBe(false);
			expect(hasCapability('opencode', 'usesCombinedContextWindow')).toBe(false);
		});
	});

	describe('capability consistency', () => {
		it('should have all fields in DEFAULT_CAPABILITIES match AgentCapabilities interface', () => {
			const expectedKeys: (keyof AgentCapabilities)[] = [
				'supportsResume',
				'supportsReadOnlyMode',
				'supportsJsonOutput',
				'supportsSessionId',
				'supportsImageInput',
				'supportsImageInputOnResume',
				'supportsSlashCommands',
				'supportsSessionStorage',
				'supportsCostTracking',
				'supportsUsageStats',
				'supportsBatchMode',
				'supportsStreaming',
				'supportsStreamJsonInput',
				'supportsPromptViaStdin',
				'supportsResultMessages',
				'supportsModelSelection',
				'requiresPromptToStart',
				'supportsThinkingDisplay',
				'supportsContextMerge',
				'supportsContextExport',
				'supportsWizard',
				'supportsGroupChatModeration',
				'usesJsonLineOutput',
				'usesCombinedContextWindow',
				'supportsAppendSystemPrompt',
				'supportsProjectMemory',
				'supportsAdditionalDirectories',
			];

			const defaultKeys = Object.keys(DEFAULT_CAPABILITIES);
			expect(defaultKeys.sort()).toEqual(expectedKeys.sort());
		});

		it('should have all agent capabilities contain all required fields', () => {
			const requiredKeys = Object.keys(DEFAULT_CAPABILITIES);

			for (const [agentId, capabilities] of Object.entries(AGENT_CAPABILITIES)) {
				const agentKeys = Object.keys(capabilities);
				// Every required key must be present in each agent
				for (const key of requiredKeys) {
					expect(agentKeys).toContain(key);
				}
				// Agent may have optional keys (e.g., imageResumeMode) not in DEFAULT_CAPABILITIES
			}
		});
	});
});

// ===== from src/__tests__/main/agents/capability-snapshot.test.ts =====

/**
 * Minimal in-memory stand-in for the agent-capabilities electron-store.
 * Mirrors the `SnapshotStoreLike` shape so the manager can persist without
 * touching disk during tests.
 */
function makeFakeStore(initial: AgentCapabilitiesSnapshotMap = {}) {
	const data: { snapshots: AgentCapabilitiesSnapshotMap } = { snapshots: { ...initial } };
	return {
		raw: data,
		get: vi.fn(<K extends 'snapshots'>(key: K, defaultValue?: AgentCapabilitiesSnapshotMap) => {
			return data[key] ?? (defaultValue as AgentCapabilitiesSnapshotMap);
		}),
		set: vi.fn(<K extends 'snapshots'>(key: K, value: AgentCapabilitiesSnapshotMap) => {
			data[key] = value;
		}),
	};
}

describe('CapabilitySnapshotManager', () => {
	let manager: CapabilitySnapshotManager;
	let store: ReturnType<typeof makeFakeStore>;
	let broadcast: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		manager = new CapabilitySnapshotManager();
		store = makeFakeStore();
		broadcast = vi.fn();
		captureMessageMock.mockReset();
	});

	it('starts empty before init()', () => {
		expect(manager.getAll()).toEqual({});
		expect(manager.get('claude-code')).toBeUndefined();
	});

	it('hydrates from the persisted store on init()', () => {
		const seeded = makeFakeStore({
			'claude-code': {
				status: 'ok',
				path: '/usr/local/bin/claude',
				lastProbedAt: 1000,
			},
		});
		manager.init(seeded);
		expect(manager.get('claude-code')?.status).toBe('ok');
		expect(manager.get('claude-code')?.path).toBe('/usr/local/bin/claude');
	});

	it('markOk persists and broadcasts an update', () => {
		manager.init(store, broadcast);
		const result = manager.markOk('claude-code', { path: '/usr/bin/claude' });

		expect(result.status).toBe('ok');
		expect(result.path).toBe('/usr/bin/claude');
		expect(result.lastProbedAt).toBeGreaterThan(0);

		expect(store.set).toHaveBeenCalledWith('snapshots', expect.any(Object));
		expect(store.raw.snapshots['claude-code']?.status).toBe('ok');

		expect(broadcast).toHaveBeenCalledTimes(1);
		const payload = broadcast.mock.calls[0][0] as SnapshotUpdatedPayload;
		expect(payload.key).toBe('claude-code');
		expect(payload.agentId).toBe('claude-code');
		expect(payload.snapshot?.status).toBe('ok');
	});

	it('markNotInstalled wipes stale path/version/models from a previous ok snapshot', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', {
			path: '/usr/bin/claude',
			version: '1.4.2',
			models: ['sonnet'],
		});
		const result = manager.markNotInstalled('claude-code');

		expect(result.status).toBe('not_installed');
		expect(result.lastError).toBeUndefined();
		// The previous binary path must NOT survive - otherwise the UI shows a
		// red "Not installed" pill alongside a valid-looking path. Same for
		// version / models, which would all be stale.
		expect(result.path).toBeUndefined();
		expect(result.version).toBeUndefined();
		expect(result.models).toBeUndefined();
		expect(broadcast).toHaveBeenCalledTimes(2);
	});

	it('markAuthRequired keeps the path and records an error message', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/bin/claude' });
		const result = manager.markAuthRequired('claude-code', 'Token expired');

		expect(result.status).toBe('auth_required');
		expect(result.lastError).toBe('Token expired');
		expect(result.path).toBe('/usr/bin/claude');
	});

	it('SSH snapshots are keyed independently of the local snapshot', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/local/bin/claude' });
		manager.markOk('claude-code', { path: '/home/dev/.local/bin/claude' }, 'remote-uuid-1');

		expect(manager.get('claude-code')?.path).toBe('/usr/local/bin/claude');
		expect(manager.get('claude-code', 'remote-uuid-1')?.path).toBe('/home/dev/.local/bin/claude');
		expect(manager.get('claude-code', 'remote-uuid-1')?.remoteId).toBe('remote-uuid-1');
	});

	it('clear() removes the snapshot and emits a null payload', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/bin/claude' });
		manager.clear('claude-code');

		expect(manager.get('claude-code')).toBeUndefined();
		const lastCall = broadcast.mock.calls.at(-1)?.[0] as SnapshotUpdatedPayload;
		expect(lastCall.snapshot).toBeNull();
		expect(lastCall.key).toBe('claude-code');
	});

	it('clear() on a missing key is a no-op (no broadcast, no persist)', () => {
		manager.init(store, broadcast);
		store.set.mockClear();
		manager.clear('not-an-agent');
		expect(broadcast).not.toHaveBeenCalled();
		expect(store.set).not.toHaveBeenCalled();
	});

	it('markProbing is transient: in-memory only, not persisted to disk', () => {
		manager.init(store, broadcast);
		store.set.mockClear();
		const result = manager.markProbing('claude-code');

		expect(result.status).toBe('probing');
		expect(manager.get('claude-code')?.status).toBe('probing');
		// Broadcast still fires so the UI can show a spinner live…
		expect(broadcast).toHaveBeenCalledTimes(1);
		// …but persist must NOT happen: a crash during reprobe would otherwise
		// hydrate a stuck "Probing…" pill on next launch.
		expect(store.set).not.toHaveBeenCalled();
	});

	it('hydrate() drops any persisted `probing` entries left over from a prior crash', () => {
		const seeded = makeFakeStore({
			'claude-code': { status: 'ok', path: '/usr/bin/claude', lastProbedAt: 1000 },
			codex: { status: 'probing', lastProbedAt: 2000 },
		});
		manager.init(seeded);
		expect(manager.get('claude-code')?.status).toBe('ok');
		expect(manager.get('codex')).toBeUndefined();
	});

	it('markFailed records the error and keeps the snapshot', () => {
		manager.init(store, broadcast);
		const result = manager.markFailed('claude-code', 'boom');
		expect(result.status).toBe('failed');
		expect(result.lastError).toBe('boom');
	});

	it('markFailed reports unexpected probe errors to Sentry', () => {
		manager.init(store, broadcast);
		manager.markFailed('claude-code', 'boom');
		expect(captureMessageMock).toHaveBeenCalledWith(
			'agent-probe-failed',
			'warning',
			expect.objectContaining({ agentId: 'claude-code' })
		);
	});

	it('markFailed skips Sentry for expected SSH/network failures but still persists (MAESTRO-RA)', () => {
		manager.init(store, broadcast);
		const expectedFailures = [
			'SSH connection timed out after 10s',
			'ssh: connect to host example.com port 22: Connection refused',
			'ssh: Could not resolve hostname badhost',
			'ssh: connect to host 10.0.0.1 port 22: No route to host',
		];
		for (const error of expectedFailures) {
			const result = manager.markFailed('claude-code', error, 'remote-1');
			expect(result.status).toBe('failed');
			expect(result.lastError).toBe(error);
		}
		expect(captureMessageMock).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/main/agents/claude-account-identity.test.ts =====

describe('readClaudeAccountIdentity', () => {
	beforeEach(() => {
		readFileMock.mockReset();
		loggerWarnMock.mockReset();
	});

	it('reads .claude.json from the config dir and returns the account identity', async () => {
		readFileMock.mockResolvedValue(
			JSON.stringify({
				oauthAccount: {
					accountUuid: '8d3c60a2-9638-49e7-95ff-45813e8b35d8',
					emailAddress: 'pedram@banaco.com',
					organizationName: "pedram@banaco.com's Organization",
				},
			})
		);

		const identity = await readClaudeAccountIdentity('/Users/test/.claude-banaco');

		expect(readFileMock).toHaveBeenCalledWith(
			path.join('/Users/test/.claude-banaco', '.claude.json'),
			'utf8'
		);
		expect(identity).toEqual({
			accountUuid: '8d3c60a2-9638-49e7-95ff-45813e8b35d8',
			email: 'pedram@banaco.com',
			organizationName: "pedram@banaco.com's Organization",
		});
	});

	it('returns null without logging when the file does not exist', async () => {
		// A config dir that was never logged into is ordinary, not an error.
		readFileMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));

		expect(await readClaudeAccountIdentity('/Users/test/.claude-fresh')).toBeNull();
		expect(loggerWarnMock).not.toHaveBeenCalled();
	});

	it('returns null and warns when the file is not valid JSON', async () => {
		readFileMock.mockResolvedValue('{ this is not json');

		expect(await readClaudeAccountIdentity('/Users/test/.claude')).toBeNull();
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining('Failed to parse'),
			expect.any(String),
			expect.objectContaining({ configPath: path.join('/Users/test/.claude', '.claude.json') })
		);
	});

	it('returns null when the JSON carries no oauthAccount', async () => {
		readFileMock.mockResolvedValue(JSON.stringify({ userID: 'abc', projects: {} }));

		expect(await readClaudeAccountIdentity('/Users/test/.claude')).toBeNull();
		expect(loggerWarnMock).not.toHaveBeenCalled();
	});

	it('does not throw when the read rejects for a non-ENOENT reason', async () => {
		readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

		await expect(readClaudeAccountIdentity('/Users/test/.claude')).resolves.toBeNull();
	});
});

// ===== from src/__tests__/main/agents/claude-mode-selector.test.ts =====

const NOW = new Date('2026-05-15T12:00:00Z');

const ONE_HOUR_MS = 60 * 60 * 1000;

const FIVE_HOURS_MS = 5 * ONE_HOUR_MS;

const ONE_WEEK_MS = 7 * 24 * ONE_HOUR_MS;

function snapshot(
	overrides: {
		sessionPercent?: number;
		weekPercent?: number;
		weekSonnetPercent?: number;
		sessionResetsAt?: string;
		weekResetsAt?: string;
		weekSonnetResetsAt?: string;
	} = {}
): UsageSnapshot {
	return {
		sampledAt: NOW.toISOString(),
		configDirKey: '/Users/test/.claude',
		session: {
			percent: overrides.sessionPercent ?? 50,
			resetsAt: overrides.sessionResetsAt ?? new Date(NOW.getTime() + FIVE_HOURS_MS).toISOString(),
		},
		weekAllModels: {
			percent: overrides.weekPercent ?? 20,
			resetsAt: overrides.weekResetsAt ?? new Date(NOW.getTime() + ONE_WEEK_MS).toISOString(),
		},
		weekSonnetOnly: {
			percent: overrides.weekSonnetPercent ?? 10,
			resetsAt: overrides.weekSonnetResetsAt ?? new Date(NOW.getTime() + ONE_WEEK_MS).toISOString(),
		},
	};
}

function input(overrides: Partial<SelectModeInput> = {}): SelectModeInput {
	return {
		perTabReason: 'auto',
		usageSnapshot: snapshot(),
		now: NOW,
		...overrides,
	};
}

describe('claude-mode-selector', () => {
	describe('LIMIT_THRESHOLD_PERCENT', () => {
		it('is exported as 99', () => {
			expect(LIMIT_THRESHOLD_PERCENT).toBe(99);
		});
	});

	describe('null snapshot', () => {
		it('falls back to interactive/auto', () => {
			expect(selectMode(input({ usageSnapshot: null }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('null snapshot ignores sticky-limit (cannot prove window still open)', () => {
			expect(selectMode(input({ usageSnapshot: null, perTabReason: 'limit' }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});
	});

	describe('under threshold', () => {
		it('both windows under 99% → interactive/auto', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 50 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('0% does not trigger', () => {
			expect(
				selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 0, weekPercent: 0 }) }))
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('limit triggers', () => {
		it('session >= 99% with window open → api/limit', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('week >= 99% with window open → api/limit', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ weekPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('both over threshold → still a single api/limit result', () => {
			expect(
				selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99, weekPercent: 100 }) }))
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('weekSonnetOnly alone does NOT trigger (selector ignores it)', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ weekSonnetPercent: 99 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		// Claude paints no "Resets ..." row for a window with nothing running in
		// it, so `resetsAt` can be absent. An unknown reset must not veto a
		// freshly-sampled 100% - the snapshot's own TTL bounds staleness.
		it('week at threshold with no scraped reset time still triggers', () => {
			const snap = snapshot({ weekPercent: 100 });
			delete snap.weekAllModels.resetsAt;
			expect(selectMode(input({ usageSnapshot: snap }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		// The sticky path leans the other way: with no reset time there is no
		// window left to wait out, so a prior fallback must not latch.
		it('sticky-limit does NOT latch on a window with no scraped reset time', () => {
			const snap = snapshot({ sessionPercent: 10, weekPercent: 10 });
			delete snap.session.resetsAt;
			delete snap.weekAllModels.resetsAt;
			expect(selectMode(input({ perTabReason: 'limit', usageSnapshot: snap }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('session at threshold but window already reset → no trigger', () => {
			const closedSession = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({ sessionPercent: 99, sessionResetsAt: closedSession }),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('threshold boundary', () => {
		it('exactly 99% triggers (>=)', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('98.9% does NOT trigger', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 98.9 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});
	});

	describe('sticky-limit', () => {
		it('perTabReason "limit" with session window still open → stays api/limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionPercent: 50, weekPercent: 10 }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit" with only week window open → stays api/limit', () => {
			const closedSession = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionResetsAt: closedSession }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit" with both windows closed → flips back to interactive/auto', () => {
			const closed = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({
							sessionResetsAt: closed,
							weekResetsAt: closed,
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('percent dropping below threshold mid-window does NOT break sticky-limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionPercent: 10, weekPercent: 5 }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "auto" with windows open but percents under threshold → interactive/auto (not sticky)', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'auto',
						usageSnapshot: snapshot({ sessionPercent: 50 }),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('purity', () => {
		it('does not mutate input', () => {
			const snap = Object.freeze(snapshot({ sessionPercent: 99 }));
			expect(() => selectMode(input({ usageSnapshot: snap }))).not.toThrow();
		});

		it('returns the same result for the same input (determinism)', () => {
			const inp = input({ usageSnapshot: snapshot({ sessionPercent: 99 }) });
			expect(selectMode(inp)).toEqual(selectMode(inp));
		});
	});
});

// ===== from src/__tests__/main/agents/codex-config.test.ts =====

describe('codex-config', () => {
	describe('getCodexHome', () => {
		it('defaults to ~/.codex', () => {
			expect(getCodexHome({})).toBe(path_1.join(os.homedir(), '.codex'));
		});

		it('honours CODEX_HOME so an alternate profile is probed', () => {
			expect(getCodexHome({ CODEX_HOME: path_1.join('/custom', 'codex') })).toBe(
				path_1.join('/custom', 'codex')
			);
		});
	});

	describe('getCodexSkillDirs', () => {
		it('puts the project-local dir ahead of the global one', () => {
			expect(getCodexSkillDirs(path_1.join('/project'), {})).toEqual([
				path_1.join('/project', '.codex', 'skills'),
				path_1.join(os.homedir(), '.codex', 'skills'),
			]);
		});

		it('omits the project dir when there is no cwd', () => {
			expect(getCodexSkillDirs(undefined, {})).toEqual([
				path_1.join(os.homedir(), '.codex', 'skills'),
			]);
		});
	});

	describe('getCodexPromptDirs', () => {
		it('probes both the project and global prompt dirs', () => {
			expect(
				getCodexPromptDirs(path_1.join('/project'), { CODEX_HOME: path_1.join('/ch') })
			).toEqual([path_1.join('/project', '.codex', 'prompts'), path_1.join('/ch', 'prompts')]);
		});
	});

	describe('parseCodexMarkdownDoc', () => {
		it('extracts name and description and strips the frontmatter', () => {
			const doc = parseCodexMarkdownDoc(
				[
					'---',
					'name: ship-it',
					'description: Cut a release',
					'---',
					'',
					'# Ship It',
					'Do the thing.',
				].join('\n')
			);
			expect(doc.name).toBe('ship-it');
			expect(doc.description).toBe('Cut a release');
			expect(doc.userInvocable).toBe(true);
			expect(doc.body).toBe('# Ship It\nDo the thing.');
		});

		it('strips surrounding quotes from frontmatter values', () => {
			const doc = parseCodexMarkdownDoc(
				['---', 'description: "Quoted: value"', '---', 'body'].join('\n')
			);
			expect(doc.description).toBe('Quoted: value');
		});

		it('treats user-invocable: false as not offerable', () => {
			const doc = parseCodexMarkdownDoc(
				['---', 'name: internal', 'user-invocable: false', '---', 'body'].join('\n')
			);
			expect(doc.userInvocable).toBe(false);
		});

		it('defaults userInvocable to true when the key is absent', () => {
			expect(
				parseCodexMarkdownDoc(['---', 'name: x', '---', 'body'].join('\n')).userInvocable
			).toBe(true);
		});

		it('ignores an indented description nested under metadata', () => {
			const doc = parseCodexMarkdownDoc(
				[
					'---',
					'name: nested',
					'metadata:',
					'  description: not the skill description',
					'---',
					'body',
				].join('\n')
			);
			expect(doc.description).toBeUndefined();
		});

		it('treats a file without frontmatter as an all-body prompt', () => {
			const doc = parseCodexMarkdownDoc('Just a prompt body.\n');
			expect(doc.name).toBeUndefined();
			expect(doc.userInvocable).toBe(true);
			expect(doc.body).toBe('Just a prompt body.');
		});

		it('keeps the whole file when the frontmatter block is never closed', () => {
			const raw = '---\nname: broken\nstill going';
			expect(parseCodexMarkdownDoc(raw).body).toBe(raw);
		});

		it('parses CRLF files, so a Windows-authored skill is not skipped', () => {
			const doc = parseCodexMarkdownDoc(
				'---\r\nname: crlf\r\ndescription: Works\r\n---\r\nbody\r\n'
			);
			expect(doc.name).toBe('crlf');
			expect(doc.description).toBe('Works');
			expect(doc.body).toBe('body');
		});
	});
});
