/**
 * The cloud screening confirmation (spec section 8.10, G2 and G3): asked the
 * first time a shared sketch's screen would run on a cloud System One engine,
 * and again when the engine in force changes to cloud while a room is live.
 *
 * It names the engine and its host, says what leaves this computer, and that
 * guests will see "Screened by a cloud service". The words come from
 * `sketchCloudScreeningDisclosure()`, so this dialog, the A1 desktop
 * confirmation and the CLI prompt say the same thing.
 *
 * - Allow stores the consent through main's consent module
 *   (`grantScreeningConsent`, the module `maestro-cli sketch screening-consent
 *   grant` reaches). The grant confirms every live room on that engine and
 *   pushes the change, on which each room client sends
 *   `screening.set {screening:'cloud'}`. No guest text goes to the engine until
 *   the server echoes `cloud` (G4).
 * - Keep local changes nothing, so the gate keeps failing closed, and offers
 *   to switch the screen back to a local classifier (`switchScreenToLocal`,
 *   downloading Prompt Guard 2 when none is installed).
 *
 * Escape and the ESC pill close the dialog as "Not now": nothing is allowed.
 * Opened by `CloudScreeningConsentHost`, never directly.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { CloudCog } from 'lucide-react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import {
	sketchCloudEngineWhere,
	sketchCloudScreeningDisclosure,
	type SketchCloudConfirmNeeded,
} from '../../../shared/sketch/cloud-consent';
import {
	sketchScreenDownloadLabel,
	type SketchLocalScreenOption,
} from '../../../shared/sketch/bot-policy';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { EscCloseButton } from '../ui/EscCloseButton';
import { ModalFooter } from '../ui/Modal';

export interface CloudScreeningConsentDialogProps {
	theme: Theme;
	prompt: SketchCloudConfirmNeeded;
	/** The dialog is done: allowed, switched to local, or dismissed. */
	onClose: () => void;
}

type Step =
	| { kind: 'ask' }
	| { kind: 'allowing' }
	| { kind: 'keep-local'; option: SketchLocalScreenOption | null }
	| { kind: 'switching'; option: SketchLocalScreenOption | null };

export const CLOUD_SCREENING_DIALOG_TITLE = 'Cloud screening';

/** Raised unasked over whatever is open (modals sit at 9999), below the secret screen's 10050. */
const CLOUD_SCREENING_Z_INDEX = 10040;

export function CloudScreeningConsentDialog({
	theme,
	prompt,
	onClose,
}: CloudScreeningConsentDialogProps) {
	const [step, setStep] = React.useState<Step>({ kind: 'ask' });
	const [error, setError] = React.useState<string | null>(null);
	const [note, setNote] = React.useState<string | null>(null);
	const mounted = React.useRef(true);
	const keepLocalRef = React.useRef<HTMLButtonElement>(null);

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useModalLayer(
		MODAL_PRIORITIES.SKETCH_CLOUD_SCREENING_CONSENT,
		CLOUD_SCREENING_DIALOG_TITLE,
		onClose
	);
	// The safe answer takes the focus, so Enter never allows by accident.
	useFocusOnMount(keepLocalRef);

	const disclosure = sketchCloudScreeningDisclosure(prompt);
	const where = sketchCloudEngineWhere(prompt.engine, prompt.host);
	const busy = step.kind === 'allowing' || step.kind === 'switching';

	const allow = async () => {
		setStep({ kind: 'allowing' });
		setError(null);
		try {
			await window.maestro.sketch.grantScreeningConsent(prompt.engine, prompt.host);
			if (mounted.current) onClose();
		} catch (err) {
			if (!mounted.current) return;
			setError(ipcErrorMessage(err));
			setStep({ kind: 'ask' });
		}
	};

	const keepLocal = async () => {
		setStep({ kind: 'keep-local', option: null });
		setError(null);
		try {
			const option = await window.maestro.sketch.localScreenOption();
			if (mounted.current) setStep({ kind: 'keep-local', option });
		} catch (err) {
			if (mounted.current) setError(ipcErrorMessage(err));
		}
	};

	const switchToLocal = async (option: SketchLocalScreenOption | null) => {
		setStep({ kind: 'switching', option });
		setError(null);
		try {
			const result = await window.maestro.sketch.switchScreenToLocal();
			if (!mounted.current) return;
			if (result.error) {
				setError(result.error);
			} else if (!result.assigned) {
				setNote(
					'The screen was given another source while this dialog was open, so it was not changed.'
				);
			} else {
				onClose();
				return;
			}
			setStep({ kind: 'keep-local', option });
		} catch (err) {
			if (!mounted.current) return;
			setError(ipcErrorMessage(err));
			setStep({ kind: 'keep-local', option });
		}
	};

	const asking = step.kind === 'ask' || step.kind === 'allowing';
	const option = step.kind === 'keep-local' || step.kind === 'switching' ? step.option : null;
	const switchLabel = option?.installed
		? `Use ${option.installed.label} on this computer`
		: sketchScreenDownloadLabel();
	const dim = { color: theme.colors.textDim };

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.6)', zIndex: CLOUD_SCREENING_Z_INDEX }}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={CLOUD_SCREENING_DIALOG_TITLE}
				data-testid="cloud-screening-consent-dialog"
				className="rounded-lg border shadow-2xl flex flex-col"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					width: 'min(520px, 92vw)',
					maxHeight: '85vh',
				}}
			>
				<div
					className="flex items-center justify-between gap-3 px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2 min-w-0">
						<CloudCog className="w-4 h-4 shrink-0" style={{ color: theme.colors.warning }} />
						<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							{asking ? disclosure.title : 'Guest text stays withheld'}
						</span>
					</div>
					<EscCloseButton theme={theme} onClose={onClose} label="Not now (Esc)" />
				</div>

				<div className="px-4 py-4 overflow-y-auto space-y-3 text-sm select-text">
					{asking ? (
						<>
							<p style={{ color: theme.colors.textMain }}>{disclosure.message}</p>
							<p className="font-medium" style={{ color: theme.colors.textMain }}>
								{where}
							</p>
							{disclosure.detail.split('\n\n').map((paragraph) => (
								<p key={paragraph} className="text-xs leading-relaxed" style={dim}>
									{paragraph}
								</p>
							))}
						</>
					) : (
						<>
							<p style={{ color: theme.colors.textMain }}>
								Nothing goes to {where}. While the screen runs there, guest requests are refused as
								"screen unavailable" and guest canvas text is withheld from your agent.
							</p>
							<p className="text-xs leading-relaxed" style={dim}>
								{option === null && step.kind === 'keep-local' && !error
									? 'Looking for a local classifier...'
									: option?.installed
										? `Switch the screen back to ${option.installed.label}, which runs on this computer.`
										: 'No local classifier is installed. Prompt Guard 2 runs on this computer once downloaded.'}
							</p>
						</>
					)}
					{note && (
						<p className="text-xs" role="status" style={{ color: theme.colors.warning }}>
							{note}
						</p>
					)}
					{error && (
						<p className="text-xs" role="alert" style={{ color: theme.colors.error }}>
							{error}
						</p>
					)}
				</div>

				<div
					className="flex justify-end gap-2 px-4 py-3 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					{asking ? (
						<ModalFooter
							theme={theme}
							cancelLabel="Keep local"
							confirmLabel={step.kind === 'allowing' ? 'Allowing...' : 'Allow'}
							confirmDisabled={busy}
							cancelButtonRef={keepLocalRef}
							onCancel={() => void keepLocal()}
							onConfirm={() => void allow()}
						/>
					) : (
						<ModalFooter
							theme={theme}
							cancelLabel="Not now"
							confirmLabel={
								step.kind === 'switching'
									? option?.installed
										? 'Switching...'
										: 'Downloading Prompt Guard 2...'
									: switchLabel
							}
							confirmDisabled={busy || (option === null && !error)}
							onCancel={onClose}
							onConfirm={() => void switchToLocal(option)}
						/>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
