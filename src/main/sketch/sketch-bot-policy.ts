/**
 * Sketch Book B2 policy (spec sections 5 and 8.3, rule 2): who may ask a
 * shared sketch's bot, the conductor alone (`conductor`) or read-write guests
 * too (`writers`).
 *
 * One implementation for the Collaborate panel's "Let collaborators ask the agent"
 * toggle and `maestro-cli sketch bot-policy`:
 *
 * - `status` reads the room's policy and `isB2Available()` for the owner.
 * - `setPolicy` sends `policy.set` through the room client in the window that
 *   owns the sketch (`botPolicy` hop). `writers` goes out only while B2 is
 *   available, checked here right before the send; from an agent caller it
 *   waits on the desktop confirmation with the trust warning (A1).
 *   `conductor` always runs.
 * - `noteRoomPolicy` is the room's own word (`welcome`, `policy`): the record
 *   mirrors it, and a room on `writers` whose B2 is no longer available is put
 *   back on `conductor` at once, with the reason for the Sketch tab.
 * - `enforce` does that for every shared sketch on `writers`. It runs when an
 *   input of `isB2Available()` changes: the `injection-screen` assignment, the
 *   System One engine, the cloud consent ({@link startSketchBotPolicyWatch}),
 *   and an outside settings write (`refreshSketchBotPolicies`).
 * - `installScreen` is the toggle's one click while the screen is `off`:
 *   download Prompt Guard 2 with its runtime and assign it, unless another
 *   source was assigned meanwhile.
 * - `switchScreenToLocal` is "Keep local" in the cloud screening confirmation
 *   (spec section 8.10): the screen goes back to an installed local
 *   classifier (`localScreenOption` names it), or to Prompt Guard 2 after the
 *   same download.
 *
 * Every change is pushed to every window on {@link SKETCH_BOT_POLICY_CHANGED_CHANNEL},
 * so an open toggle reads its state again.
 */

import type Store from 'electron-store';
import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import {
	localModelAssignmentProblem,
	parseLocalModelAssignments,
	resolveLocalModelAssignment,
	withLocalModelAssignment,
	type LocalModelAssignment,
	type LocalModelAssignments,
} from '../../shared/local-models/tasks';
import {
	SKETCH_DEFAULT_SCREEN_MODEL_ID,
	sketchB2TrustWarning,
	sketchBotPolicyDemotedNotice,
	sketchBotPolicyDemotion,
	type SketchB2Availability,
	type SketchBotPolicyStatus,
	type SketchLocalScreenOption,
	type SketchScreenInstallResult,
} from '../../shared/sketch/bot-policy';
import { SKETCH_BOOK_SETTINGS_KEY } from '../../shared/sketch/cloud-consent';
import { BOT_POLICIES, type BotPolicy, type SketchRecord } from '../../shared/sketch/types';
import {
	resolveLocalInjectionClassifier,
	type LocalInjectionClassifier,
} from '../local-models/injection-screen';
import { installLocalModel, type LocalModelInstallResult } from '../local-models/service';
import { onSystemOneChanged } from '../local-models/system-one/service';
import { getSettingsStore } from '../stores/getters';
import type { MaestroSettings } from '../stores/types';
import { logger } from '../utils/logger';
import type { SafeSendFn } from '../utils/safe-send';
import { captureException } from '../utils/sentry';
import {
	confirmSketchActionOnDesktop,
	type SketchDesktopConfirmPrompt,
} from './sketch-desktop-confirm';
import { isB2Available } from './sketch-guardrail';
import { requestSketchRenderer, type SketchRendererBridge } from './sketch-renderer-bridge';
import { findSketchOwnerAgent, type SketchCaller, type SketchOwnerAgent } from './sketch-service';
import { getSketchStore, type SketchStore } from './sketch-store';

const LOG_CONTEXT = '[SketchBook][BotPolicy]';

/** The push channel every window hears a {@link SketchBotPolicyChange} on. */
export const SKETCH_BOT_POLICY_CHANGED_CHANNEL = 'sketch:botPolicyChanged';

const LOCAL_MODEL_ASSIGNMENTS_KEY = 'localModelAssignments';
const INJECTION_SCREEN_TASK_ID = 'injection-screen';

/** What changed: one sketch, or (no `sketchId`) B2 availability for every sketch. */
export interface SketchBotPolicyChange {
	sketchId?: string;
}

export interface SketchBotPolicyDeps {
	store?: () => SketchStore;
	isEnabled?: () => boolean;
	availability?: (input: { agentId: string }) => Promise<SketchB2Availability>;
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	renderer?: SketchRendererBridge;
	/** The A1 desktop confirmation. Resolves true only on Allow. */
	confirm?: (prompt: SketchDesktopConfirmPrompt) => Promise<boolean>;
	installModel?: (modelId: string) => Promise<LocalModelInstallResult>;
	/** An installed local classifier for the screen, or null. */
	findLocalClassifier?: () => Promise<LocalInjectionClassifier | null>;
	readAssignments?: () => LocalModelAssignments;
	writeAssignments?: (assignments: LocalModelAssignments) => void;
	publish?: (change: SketchBotPolicyChange) => void;
}

export interface SketchBotPolicyService {
	status(sketchId: string): Promise<SketchBotPolicyStatus>;
	/** `policy.set` on the live room. An agent caller's `writers` waits on the conductor (A1). */
	setPolicy(
		sketchId: string,
		policy: BotPolicy,
		caller?: SketchCaller
	): Promise<SketchBotPolicyStatus>;
	/** The room said its policy (`welcome`, `policy`): mirror it, and demote it when B2 is gone. */
	noteRoomPolicy(sketchId: string, policy: BotPolicy): Promise<SketchBotPolicyStatus>;
	/** Demote every shared sketch on `writers` whose B2 is no longer available. */
	enforce(): Promise<void>;
	/** Download Prompt Guard 2 and its runtime, then assign it to the screen. */
	installScreen(): Promise<SketchScreenInstallResult>;
	/** The installed local classifier "Keep local" can switch the screen to, if any. */
	localScreenOption(): Promise<SketchLocalScreenOption>;
	/**
	 * Point the screen back at a local classifier ("Keep local", spec section
	 * 8.10): the installed one, else Prompt Guard 2 after downloading it.
	 * Replaces only a System One source or none, never a local pick made meanwhile.
	 */
	switchScreenToLocal(): Promise<SketchScreenInstallResult>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`Sketch Book: ${field} must be a non-empty string.`);
	}
	return value;
}

function requirePolicy(value: unknown): BotPolicy {
	if (!(BOT_POLICIES as readonly unknown[]).includes(value)) {
		throw new Error('Sketch Book: the bot policy must be "conductor" or "writers".');
	}
	return value as BotPolicy;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSketchBotPolicyService(
	deps: SketchBotPolicyDeps = {}
): SketchBotPolicyService {
	const store = deps.store ?? getSketchStore;
	const isEnabled =
		deps.isEnabled ?? (() => isEncoreFeatureEnabled(getSettingsStore(), 'sketchBook'));
	const availability = deps.availability ?? isB2Available;
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const renderer = deps.renderer ?? requestSketchRenderer;
	const confirm = deps.confirm ?? confirmSketchActionOnDesktop;
	const installModel = deps.installModel ?? installLocalModel;
	const findLocalClassifier = deps.findLocalClassifier ?? resolveLocalInjectionClassifier;
	const readAssignments =
		deps.readAssignments ??
		(() => parseLocalModelAssignments(getSettingsStore().get(LOCAL_MODEL_ASSIGNMENTS_KEY, {})));
	const writeAssignments =
		deps.writeAssignments ??
		((assignments: LocalModelAssignments) =>
			getSettingsStore().set(LOCAL_MODEL_ASSIGNMENTS_KEY, assignments));
	const publish = deps.publish ?? (() => {});

	/** Enforce runs one at a time, so two triggers never demote one room twice. */
	let enforcing: Promise<void> = Promise.resolve();

	function open(): SketchStore {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
		return store();
	}

	async function requireSketch(sketches: SketchStore, sketchId: unknown): Promise<SketchRecord> {
		const id = requireString(sketchId, 'sketchId');
		const record = await sketches.getSketch(id);
		if (!record) throw new Error(`Sketch Book: no sketch has the id "${id}".`);
		return record;
	}

	function statusOf(record: SketchRecord, b2: SketchB2Availability): SketchBotPolicyStatus {
		return { sketchId: record.sketchId, policy: record.share?.botPolicy ?? null, availability: b2 };
	}

	/** The owner, while it is a live local agent: the window that runs the room. */
	function requireOwner(record: SketchRecord): SketchOwnerAgent {
		const agent = findAgent(record.ownerAgentId);
		if (!agent) {
			throw new Error(`Sketch Book: the agent that owns "${record.name}" is gone.`);
		}
		if (agent.sshRemote) {
			throw new Error(`Sketch Book runs on local agents only. "${agent.name}" runs over SSH.`);
		}
		return agent;
	}

	/** Mirror the room's policy into the record. */
	async function mirror(
		sketches: SketchStore,
		record: SketchRecord,
		policy: BotPolicy
	): Promise<SketchRecord> {
		if (!record.share || record.share.botPolicy === policy) return record;
		return sketches.updateSketchShare(record.sketchId, (prev) =>
			prev ? { ...prev, botPolicy: policy } : prev
		);
	}

	/** Send `policy.set` through the owning window; the record follows on success. */
	async function send(
		sketches: SketchStore,
		record: SketchRecord,
		policy: BotPolicy,
		notice?: string
	): Promise<SketchRecord> {
		const agent = requireOwner(record);
		const result = await renderer(agent.id, {
			action: 'botPolicy',
			sketchId: record.sketchId,
			botPolicy: policy,
			...(notice ? { notice } : {}),
		});
		if (!result.success) throw new Error(result.error);
		const updated = await mirror(sketches, record, policy);
		publish({ sketchId: record.sketchId });
		return updated;
	}

	/** Put a room on `conductor` because B2 is gone. Logged, never thrown. */
	async function demote(
		sketches: SketchStore,
		record: SketchRecord,
		reason: string
	): Promise<boolean> {
		try {
			await send(sketches, record, 'conductor', sketchBotPolicyDemotedNotice(reason));
			logger.info('Collaborators can no longer ask the agent', LOG_CONTEXT, {
				sketchId: record.sketchId,
				reason,
			});
			return true;
		} catch (error) {
			// No live room in a window: the next `welcome` says `writers` and lands here again.
			logger.warn('Could not put a room back on conductor', LOG_CONTEXT, {
				sketchId: record.sketchId,
				error: errorMessage(error),
			});
			return false;
		}
	}

	async function runEnforce(): Promise<void> {
		if (!isEnabled()) return;
		const sketches = store();
		const records = (await sketches.listSketches()).filter(
			(record) => record.share?.botPolicy === 'writers'
		);
		const byAgent = new Map<string, SketchB2Availability>();
		for (const record of records) {
			let b2 = byAgent.get(record.ownerAgentId);
			if (!b2) {
				b2 = await availability({ agentId: record.ownerAgentId });
				byAgent.set(record.ownerAgentId, b2);
			}
			const reason = sketchBotPolicyDemotion('writers', b2);
			if (reason) await demote(sketches, record, reason);
		}
	}

	/** Install Prompt Guard 2 and its runtime. Resolves with why it failed, or null. */
	async function installDefaultScreen(): Promise<string | null> {
		const result = await installModel(SKETCH_DEFAULT_SCREEN_MODEL_ID);
		const runtimeReady = result.runtime.status === 'ready' || result.runtime.status === 'installed';
		if (result.status === 'complete' && runtimeReady) return null;
		return result.status !== 'complete'
			? (result.error ?? `The download ended ${result.status}.`)
			: (result.runtime.error ?? `Its runtime is ${result.runtime.status}.`);
	}

	/** Point `injection-screen` at an installed classifier while the current source is replaceable. */
	function assignScreen(
		modelId: string,
		replaceable: (current: LocalModelAssignment['type']) => boolean
	): SketchScreenInstallResult {
		const assignments = readAssignments();
		if (!replaceable(resolveLocalModelAssignment(assignments, INJECTION_SCREEN_TASK_ID).type)) {
			publish({});
			return { installed: true, assigned: false };
		}
		const next: LocalModelAssignment = { type: 'local', modelId };
		const problem = localModelAssignmentProblem(INJECTION_SCREEN_TASK_ID, next);
		if (problem) return { installed: true, assigned: false, error: problem };
		writeAssignments(withLocalModelAssignment(assignments, INJECTION_SCREEN_TASK_ID, next));
		logger.info('Local classifier assigned to the injection screen', LOG_CONTEXT, { modelId });
		publish({});
		return { installed: true, assigned: true };
	}

	return {
		async status(sketchId) {
			const record = await requireSketch(open(), sketchId);
			return statusOf(record, await availability({ agentId: record.ownerAgentId }));
		},

		async setPolicy(sketchId, policy, caller) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const wanted = requirePolicy(policy);
			if (!record.share) throw new Error(`Sketch Book: "${record.name}" is not shared.`);
			if (wanted === 'writers') {
				const b2 = await availability({ agentId: record.ownerAgentId });
				if (!b2.ok) {
					throw new Error(
						`Sketch Book: collaborators cannot ask the agent on "${record.name}". ${b2.reason}`
					);
				}
				const requestedBy = caller?.requestedBy;
				if (requestedBy) {
					const allowed = await confirm({ ...sketchB2TrustWarning(record.name), requestedBy });
					if (!allowed) {
						throw new Error('Sketch Book: the conductor chose Deny, so nothing was changed.');
					}
					// The conductor may have answered long after the check above.
					const after = await availability({ agentId: record.ownerAgentId });
					if (!after.ok) {
						throw new Error(
							`Sketch Book: collaborators cannot ask the agent on "${record.name}". ${after.reason}`
						);
					}
				}
			}
			const updated = await send(sketches, record, wanted);
			logger.info('Sketch Book bot policy set', LOG_CONTEXT, {
				sketchId: record.sketchId,
				policy: wanted,
				byAgent: Boolean(caller?.requestedBy),
			});
			return statusOf(updated, await availability({ agentId: record.ownerAgentId }));
		},

		async noteRoomPolicy(sketchId, policy) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const said = requirePolicy(policy);
			let current = await mirror(sketches, record, said);
			const b2 = await availability({ agentId: record.ownerAgentId });
			const reason = sketchBotPolicyDemotion(said, b2);
			if (reason && (await demote(sketches, current, reason))) {
				current = (await sketches.getSketch(record.sketchId)) ?? current;
			}
			return statusOf(current, b2);
		},

		enforce() {
			const run = enforcing.then(runEnforce).catch((error) => {
				void captureException(error, { operation: 'sketch:enforceBotPolicy' });
			});
			enforcing = run;
			publish({});
			return run;
		},

		async installScreen() {
			if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
			const error = await installDefaultScreen();
			if (error) return { installed: false, assigned: false, error };
			// Never clobber a source the conductor picked while the download ran.
			return assignScreen(SKETCH_DEFAULT_SCREEN_MODEL_ID, (type) => type === 'off');
		},

		async localScreenOption() {
			if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
			const local = await findLocalClassifier();
			return { installed: local ? { modelId: local.modelId, label: local.source.label } : null };
		},

		async switchScreenToLocal() {
			if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
			let modelId = (await findLocalClassifier())?.modelId;
			if (!modelId) {
				const error = await installDefaultScreen();
				if (error) return { installed: false, assigned: false, error };
				modelId = SKETCH_DEFAULT_SCREEN_MODEL_ID;
			}
			// Replace the System One source the conductor kept local from (or none),
			// never a local pick made while the dialog was open.
			return assignScreen(modelId, (type) => type === 'system-one' || type === 'off');
		},
	};
}

let defaultService: SketchBotPolicyService | null = null;
let publishToWindows: SafeSendFn | null = null;

/** The app's B2 policy service. */
export function getSketchBotPolicy(): SketchBotPolicyService {
	defaultService ??= createSketchBotPolicyService({
		publish: (change) => publishToWindows?.(SKETCH_BOT_POLICY_CHANGED_CHANNEL, change),
	});
	return defaultService;
}

/**
 * Follow every input of `isB2Available()` that can change under a room on
 * `writers`: the screen's assignment, the System One engine, and the
 * `sketchBook` setting (cloud consent). Returns the stop.
 */
export function startSketchBotPolicyWatch(options: {
	settingsStore?: Store<MaestroSettings>;
	safeSend?: SafeSendFn;
}): () => void {
	publishToWindows = options.safeSend ?? null;
	const service = getSketchBotPolicy();
	const enforce = () => void service.enforce();
	const store = options.settingsStore ?? getSettingsStore();
	const offAssignments = store.onDidChange(LOCAL_MODEL_ASSIGNMENTS_KEY, enforce);
	const offSketchBook = store.onDidChange(SKETCH_BOOK_SETTINGS_KEY, enforce);
	const offSystemOne = onSystemOneChanged(enforce);
	return () => {
		offAssignments();
		offSketchBook();
		offSystemOne();
		publishToWindows = null;
	};
}

/** Check every room on `writers` again after an outside settings write. */
export function refreshSketchBotPolicies(): void {
	if (!defaultService) return;
	void defaultService.enforce();
}
