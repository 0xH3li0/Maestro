import { useEffect } from 'react';
import { CloudOff, ShieldCheck } from 'lucide-react';
import { formatRelativeTime } from '../../../../../../shared/formatters';
import {
	normalizeSketchBookSettings,
	sketchCloudEngineLabel,
	SKETCH_CLOUD_ENGINES,
	type SketchCloudEngine,
	type SketchCloudScreenConsent,
} from '../../../../../../shared/sketch/cloud-consent';
import { notifyToast } from '../../../../../stores/notificationStore';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import { ipcErrorMessage } from '../../../../../utils/ipcErrorMessage';
import type { Theme } from '../../../../../types';
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
 * Sketch Book's settings, shown in its Extensions tile: the consent to screen
 * guest text on a cloud System One engine (spec section 8.10, G2). The default
 * is local and nothing here grants a consent: it is granted from the
 * confirmation that names the provider and what leaves the machine, the first
 * time a shared sketch would use a cloud engine. Revoke goes through main's
 * consent module, the same one `maestro-cli sketch screening-consent revoke`
 * reaches, so a live room stops using the engine at once.
 */
export function SketchBookSection({ theme }: SketchBookSectionProps) {
	const consent = useSettingsStore((s) => s.sketchBookSettings.cloudScreenConsent) ?? {};

	// A grant from the confirmation dialog or the CLI lands in main; follow it here.
	useEffect(
		() => window.maestro?.sketch?.onScreeningChanged?.((change) => mirrorConsent(change.consent)),
		[]
	);

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
											: 'Not allowed: guest text never goes to this engine'}
									</div>
								</div>
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
						);
					})}
				</div>
			</div>
		</div>
	);
}
