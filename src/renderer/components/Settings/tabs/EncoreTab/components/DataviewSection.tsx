import { AlertTriangle, Code2, FolderLock, X } from 'lucide-react';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface DataviewSectionProps {
	theme: Theme;
}

/**
 * Dataview's settings, shown in its Extensions tile: the DataviewJS switch and
 * the vault roots whose scripts run without asking (D3). DQL needs no setting;
 * it runs whenever the tile is on.
 */
export function DataviewSection({ theme }: DataviewSectionProps) {
	const dataviewJsEnabled = useSettingsStore((s) => s.dataviewJsEnabled);
	const setDataviewJsEnabled = useSettingsStore((s) => s.setDataviewJsEnabled);
	const trustedRoots = useSettingsStore((s) => s.dataviewJsTrustedRoots);
	const setTrustedRoots = useSettingsStore((s) => s.setDataviewJsTrustedRoots);

	return (
		<div data-setting-id="encore-dataview" className="space-y-5 pt-4">
			<div data-setting-id="encore-dataview-js">
				<SettingsSectionHeading
					icon={Code2}
					description="Dataview queries (dataview blocks and inline = spans) always render while this feature is on. DataviewJS blocks are scripts, so they have their own switch."
				>
					DataviewJS
				</SettingsSectionHeading>
				<div
					className="flex items-start gap-1.5 text-xs mb-2"
					style={{ color: theme.colors.warning }}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						DataviewJS runs code from your notes. Scripts run in an isolated sandbox with no access
						to Maestro or your files outside the vault, and only in vaults you trust.
					</span>
				</div>
				<SectionCard theme={theme}>
					<ToggleSettingRow
						theme={theme}
						title="Run DataviewJS"
						description={
							dataviewJsEnabled
								? 'dataviewjs blocks and inline $= spans run in trusted vaults. In any other vault a block shows its source and a Run button.'
								: 'dataviewjs blocks and inline $= spans show their source and never run.'
						}
						checked={dataviewJsEnabled}
						onChange={setDataviewJsEnabled}
						clickableRow
					/>
				</SectionCard>
			</div>

			<div data-setting-id="encore-dataview-trusted-roots">
				<SettingsSectionHeading
					icon={FolderLock}
					description="Vaults whose DataviewJS scripts run without asking. Choose Always trust this vault on a block to add one."
				>
					Trusted Vaults
				</SettingsSectionHeading>
				<SectionCard theme={theme}>
					{trustedRoots.length === 0 ? (
						<p className="text-xs opacity-70">No vault is trusted.</p>
					) : (
						<div className="space-y-1">
							{trustedRoots.map((root) => (
								<div
									key={root}
									className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
										{root}
									</span>
									<button
										type="button"
										onClick={() => setTrustedRoots(trustedRoots.filter((r) => r !== root))}
										className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
										style={{ color: theme.colors.error }}
										title="Stop trusting this vault"
										aria-label={`Stop trusting ${root}`}
									>
										<X className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}
				</SectionCard>
			</div>
		</div>
	);
}
