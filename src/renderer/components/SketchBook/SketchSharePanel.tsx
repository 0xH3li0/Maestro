/**
 * The Sketch tab's Collaborate panel (spec section 6): sign in to RunMaestro.ai,
 * share the sketch, copy a new link, revoke one, let collaborators ask the
 * agent (B2, `SketchBotPolicyToggle`), reset all access, or stop sharing.
 *
 * Every action is a `window.maestro.sketch.*` call into the one SketchService
 * that `maestro-cli sketch share|unshare|revoke-link|rotate|owner` also
 * reaches. A link holds the room key and its cap, and the server returns the
 * cap once, so a new link is copied straight to the clipboard
 * (`flashCopiedToClipboard()` names it, never shows it). Only when the
 * clipboard refuses is the link shown here, once, to copy by hand.
 *
 * Reset all access and Stop sharing ask again in place before they run.
 */

import React from 'react';
import { Link2, RotateCcw, Share2, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { SketchOwnerStatus } from '../../../shared/sketch/server';
import type { SketchLinkRole, SketchRecord } from '../../../shared/sketch/types';
import { formatFutureTime, formatRelativeTime } from '../../../shared/formatters';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Spinner } from '../ui/Spinner';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { shareSketchAndCopyLink, sketchLinkLabel } from '../../services/sketchSharing';
import { SketchBotPolicyToggle } from './SketchBotPolicyToggle';

export interface SketchSharePanelProps {
	sketchId: string;
	theme: Theme;
	onClose: () => void;
}

const ROLE_OPTIONS = [
	{ value: 'rw' as const, label: 'Can edit' },
	{ value: 'ro' as const, label: 'Can view' },
];

type Armed = 'unshare' | 'rotate' | null;

export function SketchSharePanel({ sketchId, theme, onClose }: SketchSharePanelProps) {
	const [record, setRecord] = React.useState<SketchRecord | null>(null);
	const [owner, setOwner] = React.useState<SketchOwnerStatus | null>(null);
	const [email, setEmail] = React.useState('');
	const [role, setRole] = React.useState<SketchLinkRole>('rw');
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	/** A link the clipboard refused: shown once, to copy by hand. */
	const [uncopied, setUncopied] = React.useState<string | null>(null);
	const [armed, setArmed] = React.useState<Armed>(null);
	const mounted = React.useRef(true);

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = React.useCallback(async () => {
		const [nextRecord, nextOwner] = await Promise.all([
			window.maestro.sketch.get(sketchId),
			window.maestro.sketch.ownerStatus(),
		]);
		if (!mounted.current) return;
		setRecord(nextRecord);
		setOwner(nextOwner);
	}, [sketchId]);

	React.useEffect(() => {
		refresh().catch((err) => setError(ipcErrorMessage(err)));
	}, [refresh]);

	/** Run one action: busy while it runs, its error shown, the state read again after. */
	const run = React.useCallback(
		async (action: () => Promise<void>) => {
			setBusy(true);
			setError(null);
			setArmed(null);
			try {
				await action();
			} catch (err) {
				if (mounted.current) setError(ipcErrorMessage(err));
			} finally {
				if (mounted.current) setBusy(false);
				await refresh().catch(() => undefined);
			}
		},
		[refresh]
	);

	const register = () =>
		run(async () => {
			await window.maestro.sketch.registerOwner(email);
			if (mounted.current) setOwner(await window.maestro.sketch.ownerStatus());
			// Main polls until the link in the email is clicked (15 minutes at most).
			// Not part of the busy state: the panel stays usable, to send the email again.
			void window.maestro.sketch
				.waitForOwner()
				.then((status) => {
					if (mounted.current) setOwner(status);
				})
				.catch((err) => {
					if (mounted.current) setError(ipcErrorMessage(err));
				});
		});

	const share = () =>
		run(async () => {
			setUncopied(null);
			const { result, copied } = await shareSketchAndCopyLink(sketchId, { role });
			if (!copied && mounted.current) setUncopied(result.link.url);
		});

	const panelStyle = {
		borderLeft: `1px solid ${theme.colors.border}`,
		backgroundColor: theme.colors.bgSidebar,
	};
	const dim = { color: theme.colors.textDim };
	const shared = record?.share ?? null;
	const liveLinks = shared?.links.filter((link) => !link.revoked) ?? [];
	const signedIn = owner?.state === 'confirmed' && !owner.otherServer;

	return (
		<aside
			className="w-80 shrink-0 flex flex-col min-h-0 select-none"
			aria-label="Collaborate on this sketch"
			data-sketch-share-panel=""
			style={panelStyle}
		>
			<div
				className="px-3 py-2 flex items-center justify-between text-xs font-medium"
				style={{ ...dim, borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<span>{shared ? 'Shared on RunMaestro.ai' : 'Collaborate'}</span>
				<button
					type="button"
					aria-label="Close the Collaborate panel"
					className="p-0.5 rounded hover:bg-white/10"
					onClick={onClose}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 text-xs">
				{owner === null && <Spinner size={16} color={theme.colors.accent} />}

				{owner !== null && !signedIn && (
					<div className="flex flex-col gap-2">
						<div style={dim}>
							{owner.state === 'pending' && !owner.otherServer
								? `A confirmation email went to ${owner.email}. Open the link in it; this panel updates when it is clicked.`
								: owner.otherServer
									? `You are signed in on ${owner.serverUrl}, not the server Sketch Book uses now. Sign in again.`
									: 'Sharing goes through RunMaestro.ai. Sign in with your email first: you get a link to confirm it.'}
						</div>
						<input
							type="email"
							value={email}
							placeholder="you@example.com"
							aria-label="Email"
							className="px-2 py-1 rounded outline-none select-text"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
							onChange={(event) => setEmail(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && email.trim() && !busy) void register();
							}}
						/>
						<HeaderActionButton
							theme={theme}
							onClick={() => void register()}
							disabled={busy || !email.trim()}
						>
							{owner.state === 'pending' ? 'Send it again' : 'Send confirmation link'}
						</HeaderActionButton>
					</div>
				)}

				{signedIn && (
					<>
						<div style={dim}>Signed in as {owner?.email}.</div>
						<div className="flex flex-col gap-2">
							<SegmentedControl
								value={role}
								onChange={setRole}
								options={ROLE_OPTIONS}
								theme={theme}
								ariaLabel="What the link allows"
							/>
							<HeaderActionButton
								theme={theme}
								onClick={() => void share()}
								disabled={busy}
								icon={shared ? <Link2 /> : <Share2 />}
							>
								{shared ? 'Copy a new link' : 'Share and copy link'}
							</HeaderActionButton>
							<div style={dim}>
								{role === 'rw'
									? 'Anyone with the link can view and edit, for 7 days.'
									: 'Anyone with the link can view, for 30 days.'}{' '}
								The link holds the key, so it is copied once and not kept here.
							</div>
						</div>
					</>
				)}

				{uncopied && (
					<div className="flex flex-col gap-1">
						<div style={{ color: theme.colors.warning }}>
							The clipboard refused the link. Copy it now; it is not shown again.
						</div>
						<textarea
							readOnly
							value={uncopied}
							rows={3}
							className="px-2 py-1 rounded resize-none select-text"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
							onFocus={(event) => event.currentTarget.select()}
						/>
					</div>
				)}

				{shared && (
					<div className="flex flex-col gap-1">
						<div className="font-medium" style={dim}>
							Links
						</div>
						{liveLinks.length === 0 && <div style={dim}>No live links.</div>}
						{liveLinks.map((link) => (
							<div
								key={link.capId}
								className="flex items-center justify-between gap-2 py-1"
								data-sketch-link={link.capId}
							>
								<div className="min-w-0">
									<div style={{ color: theme.colors.textMain }}>
										{sketchLinkLabel(link.role, link.label)}
									</div>
									<div style={dim}>
										Made {formatRelativeTime(link.createdAt)}
										{link.expiresAt !== null ? `, expires ${formatFutureTime(link.expiresAt)}` : ''}
									</div>
								</div>
								<HeaderActionButton
									theme={theme}
									variant="ghost"
									disabled={busy}
									onClick={() =>
										void run(async () => {
											await window.maestro.sketch.revokeLink(sketchId, link.capId);
										})
									}
								>
									Revoke
								</HeaderActionButton>
							</div>
						))}
					</div>
				)}

				{shared && signedIn && record && (
					<div className="pt-2" style={{ borderTop: `1px solid ${theme.colors.border}` }}>
						<SketchBotPolicyToggle sketchId={sketchId} sketchName={record.name} theme={theme} />
					</div>
				)}

				{shared && signedIn && (
					<div
						className="flex flex-col gap-2 pt-2"
						style={{ borderTop: `1px solid ${theme.colors.border}` }}
					>
						{armed === null && (
							<>
								<HeaderActionButton
									theme={theme}
									variant="ghost"
									icon={<RotateCcw />}
									disabled={busy}
									onClick={() => setArmed('rotate')}
								>
									Reset all access
								</HeaderActionButton>
								<HeaderActionButton
									theme={theme}
									variant="ghost"
									disabled={busy}
									onClick={() => setArmed('unshare')}
								>
									Stop sharing
								</HeaderActionButton>
							</>
						)}
						{armed !== null && (
							<div className="flex flex-col gap-2">
								<div style={{ color: theme.colors.warning }}>
									{armed === 'rotate'
										? 'Every link stops working and every guest is disconnected. The room history is cleared and the sketch is uploaded again under a new key.'
										: 'The room is deleted on RunMaestro.ai and every guest is disconnected. The sketch stays on this computer.'}
								</div>
								<div className="flex gap-2">
									<HeaderActionButton
										theme={theme}
										disabled={busy}
										onClick={() =>
											void run(async () => {
												if (armed === 'rotate') await window.maestro.sketch.rotate(sketchId);
												else await window.maestro.sketch.unshare(sketchId);
											})
										}
									>
										{armed === 'rotate' ? 'Reset all access' : 'Stop sharing'}
									</HeaderActionButton>
									<HeaderActionButton theme={theme} variant="ghost" onClick={() => setArmed(null)}>
										Cancel
									</HeaderActionButton>
								</div>
							</div>
						)}
					</div>
				)}

				{busy && <Spinner size={16} color={theme.colors.accent} />}
				{error && (
					<div className="select-text" role="alert" style={{ color: theme.colors.error }}>
						{error}
					</div>
				)}
			</div>
		</aside>
	);
}
