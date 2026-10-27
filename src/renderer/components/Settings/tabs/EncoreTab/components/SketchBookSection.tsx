import { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudOff, ShieldCheck } from 'lucide-react';
import { formatRelativeTime } from '../../../../../../shared/formatters';
import {
	normalizeSketchBookSettings,
	sketchCloudEngineLabel,
	SKETCH_CLOUD_ENGINES,
	type SketchCloudConfirmNeeded,
	type SketchCloudEngine,
	type SketchCloudScreenConsent,
} from '../../../../../../shared/sketch/cloud-consent';
import type { InjectionSourceInfo } from '../../../../../../shared/local-models/injection-screen';
import { notifyToast } from '../../../../../stores/notificationStore';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import { ipcErrorMessage } from '../../../../../utils/ipcErrorMessage';
import type { Theme } from '../../../../../types';
import { CloudScreeningConsentDialog } from '../../../../SketchBook/CloudScreeningConsentDialog';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ActionButton } from './ActionButton';

interface SketchBookSectionProps {
	theme: Theme;
}

/** Mirror a consent main reported, without writing it back. */
function mirrorConsent(consent: SketchCloudScreenConsent): void {
	useSettingsStore.setState((state) => ({
		sketchBookSettings: normalizeSketchBookSettings({
			...state.sketchBookSettings,
			cloudScreenConsent: consent,
		}),
	}));
}

/**
 * The host an OpenJev consent would be bound to: the OpenJev server in force,
 * or null when the screen does not run on OpenJev (a consent needs a host, G2).
 */
function openJevHostInForce(source: InjectionSourceInfo | null): string | null {
	return source?.kind === 'openjev' && source.host ? source.host : null;
}

/**
 * Sketch Book's settings, shown in its Extensions tile: the consent to screen
 * guest text on a cloud System One engine (spec section 8.10, G2). The default
 * is local. Allow opens the same confirmation a live room raises
 * (`CloudScreeningConsentDialog`), which names the provider, its host and what
 * leaves the machine, so a consent is never granted without the disclosure.
 * OpenJev is bound to a host, so it can be allowed only while it is the System
 * One engine in force. Grant and revoke go through main's consent module, the
 * one `maestro-cli sketch screening-consent` reaches, so a live room follows
 * at once.
 */
export function SketchBookSection({ theme }: SketchBookSectionProps) {
	const consent = useSettingsStore((s) => s.sketchBookSettings.cloudScreenConsent) ?? {};
	const [source, setSource] = useState<InjectionSourceInfo | null>(null);
	const [asking, setAsking] = useState<SketchCloudConfirmNeeded | null>(null);

	const readStatus = useCallback(() => {
		window.maestro.sketch
			.screeningConsentStatus()
			.then((status) => {
				mirrorConsent(status.consent);
				setSource(status.source);
			})
			.catch((error: unknown) => {
				notifyToast({
					color: 'red',
					title: 'Sketch Book',
					message: `Could not read the screening consent: ${ipcErrorMessage(error)}`,
				});
			});
	}, []);

	useEffect(() => readStatus(), [readStatus]);

	// A grant from the confirmation dialog or the CLI lands in main; follow it here.
	useEffect(
		() =>
			window.maestro?.sketch?.onScreeningChanged?.((change) => {
				mirrorConsent(change.consent);
				readStatus();
			}),
		[readStatus]
	);

	const allow = (engine: SketchCloudEngine) => {
		const host =
			engine === 'openjev'
				? openJevHostInForce(source)
				: source?.kind === 'jev'
					? source.host
					: undefined;
		setAsking({ engine, ...(host ? { host } : {}), reason: 'grant' });
	};

	const revoke = (engine: SketchCloudEngine) => {
		window.maestro.sketch
			.revokeScreeningConsent(engine)
			.then((status) => mirrorConsent(status.consent))
			.catch((error: unknown) => {
				notifyToast({
					color: 'red',
					title: 'Sketch Book',
					message: `Could not revoke consent for ${sketchCloudEngineLabel(engine)}: ${ipcErrorMessage(error)}`,
				});
			});
	};

	return (
		<div data-setting-id="encore-sketch-book" className="space-y-5 pt-4">
			<div>
				<SettingsSectionHeading
					icon={ShieldCheck}
					description="Guest chat and canvas text is screened for prompt injection before your agent reads it. The screen runs on this computer by default. A cloud System One engine (Jev or OpenJev) is used only after you allow it in a confirmation, and guests are told before any of their text is sent."
				>
					Cloud screening consent
				</SettingsSectionHeading>
				<div className="space-y-2">
					{SKETCH_CLOUD_ENGINES.map((engine) => {
						const granted = consent[engine];
						const host = engine === 'openjev' ? consent.openjev?.host : undefined;
						const openJevHost = engine === 'openjev' ? openJevHostInForce(source) : null;
						// OpenJev consent is per host: a new server in force can be allowed too.
						const canAllow =
							engine === 'jev'
								? !granted
								: openJevHost !== null && openJevHost !== consent.openjev?.host;
						const needsOpenJev = engine === 'openjev' && !granted && openJevHost === null;
						return (
							<div
								key={engine}
								data-testid={`sketch-book-consent-${engine}`}
								className="flex items-center justify-between gap-3 rounded border px-3 py-2"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="min-w-0">
									<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
										{sketchCloudEngineLabel(engine)}
										{host ? ` at ${host}` : ''}
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{granted
											? `Allowed ${formatRelativeTime(granted.grantedAt)}`
											: needsOpenJev
												? 'Not allowed. To allow it, set OpenJev as the System One engine first (Settings > Models > System One): consent is bound to its server.'
												: 'Not allowed: guest text never goes to this engine'}
									</div>
								</div>
								<div className="flex shrink-0 gap-2">
									{canAllow && (
										<ActionButton
											theme={theme}
											icon={Cloud}
											label={granted && openJevHost ? `Allow ${openJevHost}...` : 'Allow...'}
											onClick={() => allow(engine)}
										/>
									)}
									{granted && (
										<ActionButton
											theme={theme}
											icon={CloudOff}
											label="Revoke"
											destructive
											onClick={() => revoke(engine)}
										/>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{asking && (
				<CloudScreeningConsentDialog
					theme={theme}
					prompt={asking}
					offerLocalSwitch={false}
					onClose={() => setAsking(null)}
				/>
			)}
		</div>
	);
}
