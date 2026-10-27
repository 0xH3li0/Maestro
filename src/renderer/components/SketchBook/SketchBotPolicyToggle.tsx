/**
 * "Let collaborators ask the agent" (spec section 5, B2), in the Collaborate panel.
 *
 * The switch follows the live room's policy. Turning it on shows the trust
 * warning in place and sends `policy.set {botPolicy:'writers'}` only on
 * Confirm, and only while `isB2Available()` says so (main checks again before
 * the send). Turning it off sends `conductor` at once. While B2 is not
 * available the switch is greyed out with the reason; while the screen is
 * merely `off`, one click downloads Prompt Guard 2 and assigns it (spec
 * section 8.3, rule 2).
 *
 * The rules live in `reduceSketchBotPolicyToggle()` (`shared/sketch/bot-policy.ts`);
 * every action is a `window.maestro.sketch.*` call into the service that
 * `maestro-cli sketch bot-policy` reaches too.
 */

import React from 'react';
import { Download } from 'lucide-react';
import type { Theme } from '../../types';
import {
	INITIAL_SKETCH_BOT_POLICY_TOGGLE,
	reduceSketchBotPolicyToggle,
	sketchB2TrustWarning,
	sketchBotPolicyToggleView,
	sketchScreenDownloadLabel,
	SKETCH_B2_TOGGLE_LABEL,
	type SketchB2Availability,
	type SketchBotPolicyToggleContext,
	type SketchBotPolicyToggleEvent,
	type SketchBotPolicyToggleState,
} from '../../../shared/sketch/bot-policy';
import type { BotPolicy } from '../../../shared/sketch/types';
import { useSketchSessionStore } from '../../stores/sketchSessionStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { Spinner } from '../ui/Spinner';
import { ToggleSwitch } from '../ui/ToggleSwitch';

export interface SketchBotPolicyToggleProps {
	sketchId: string;
	sketchName: string;
	theme: Theme;
}

/** The room's policy while this window's socket is joined, else null. */
function useLivePolicy(sketchId: string): BotPolicy | null {
	return useSketchSessionStore((s) => {
		const room = s.sessions[sketchId]?.room;
		if (!room || (room.connection !== 'live' && room.connection !== 'catching-up')) return null;
		return room.botPolicy;
	});
}

export function SketchBotPolicyToggle({ sketchId, sketchName, theme }: SketchBotPolicyToggleProps) {
	const policy = useLivePolicy(sketchId);
	const [availability, setAvailability] = React.useState<SketchB2Availability | null>(null);
	const [state, setState] = React.useState<SketchBotPolicyToggleState>(
		INITIAL_SKETCH_BOT_POLICY_TOGGLE
	);
	const [installing, setInstalling] = React.useState(false);
	const [installError, setInstallError] = React.useState<string | null>(null);
	const mounted = React.useRef(true);
	const context: SketchBotPolicyToggleContext = { policy, availability };
	const contextRef = React.useRef(context);
	contextRef.current = context;
	const stateRef = React.useRef(state);
	stateRef.current = state;

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = React.useCallback(async () => {
		try {
			const status = await window.maestro.sketch.botPolicyStatus(sketchId);
			if (mounted.current) setAvailability(status.availability);
		} catch (err) {
			if (mounted.current) setAvailability({ ok: false, reason: ipcErrorMessage(err) });
		}
	}, [sketchId]);

	React.useEffect(() => {
		void refresh();
		return window.maestro.sketch.onBotPolicyChanged((change) => {
			if (!change.sketchId || change.sketchId === sketchId) void refresh();
		});
	}, [sketchId, refresh]);

	const dispatch = React.useCallback(
		(event: SketchBotPolicyToggleEvent) => {
			const step = reduceSketchBotPolicyToggle(stateRef.current, event, contextRef.current);
			stateRef.current = step.state;
			setState(step.state);
			if (!step.send) return;
			window.maestro.sketch
				.setBotPolicy(sketchId, step.send)
				.then((status) => {
					if (!mounted.current) return;
					setAvailability(status.availability);
					dispatch({ type: 'sent' });
				})
				.catch((err) => {
					if (mounted.current) dispatch({ type: 'failed', error: ipcErrorMessage(err) });
				});
		},
		[sketchId]
	);

	// A policy frame or a new availability read can withdraw an open warning.
	React.useEffect(() => {
		dispatch({ type: 'context' });
	}, [policy, availability, dispatch]);

	const installScreen = async () => {
		setInstalling(true);
		setInstallError(null);
		try {
			const result = await window.maestro.sketch.installScreen();
			if (mounted.current && result.error) setInstallError(result.error);
		} catch (err) {
			if (mounted.current) setInstallError(ipcErrorMessage(err));
		} finally {
			if (mounted.current) setInstalling(false);
			await refresh();
		}
	};

	const view = sketchBotPolicyToggleView(state, context);
	const warning = view.confirming ? sketchB2TrustWarning(sketchName) : null;
	const dim = { color: theme.colors.textDim };

	return (
		<div className="flex flex-col gap-2" data-sketch-bot-policy="">
			<div className="flex items-center justify-between gap-2">
				<span style={{ color: theme.colors.textMain }}>{SKETCH_B2_TOGGLE_LABEL}</span>
				<ToggleSwitch
					checked={view.checked}
					onChange={() => dispatch({ type: 'toggle' })}
					theme={theme}
					size="sm"
					ariaLabel={SKETCH_B2_TOGGLE_LABEL}
					title={view.reason ?? undefined}
					disabled={view.disabled}
					busy={view.busy}
				/>
			</div>
			<div style={dim}>
				{view.checked
					? 'Guests with an edit link can ask the agent. Each request waits for you to press Run.'
					: 'Only you can ask the agent.'}
			</div>
			{view.reason && (
				<div style={dim} data-sketch-b2-reason="">
					{view.reason}
				</div>
			)}
			{view.offerScreenDownload && (
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					icon={installing ? <Spinner size={12} color={theme.colors.accent} /> : <Download />}
					disabled={installing}
					onClick={() => void installScreen()}
				>
					{installing ? 'Downloading Prompt Guard 2...' : sketchScreenDownloadLabel()}
				</HeaderActionButton>
			)}
			{warning && (
				<div className="flex flex-col gap-2" role="alertdialog" aria-label={warning.title}>
					<div className="font-medium" style={{ color: theme.colors.warning }}>
						{warning.title}
					</div>
					<div style={{ color: theme.colors.textMain }}>{warning.message}</div>
					<div style={dim}>{warning.detail}</div>
					<div className="flex gap-2">
						<HeaderActionButton theme={theme} onClick={() => dispatch({ type: 'confirm' })}>
							Let them ask
						</HeaderActionButton>
						<HeaderActionButton
							theme={theme}
							variant="ghost"
							onClick={() => dispatch({ type: 'cancel' })}
						>
							Cancel
						</HeaderActionButton>
					</div>
				</div>
			)}
			{(view.error || installError) && (
				<div className="select-text" role="alert" style={{ color: theme.colors.error }}>
					{view.error ?? installError}
				</div>
			)}
		</div>
	);
}
