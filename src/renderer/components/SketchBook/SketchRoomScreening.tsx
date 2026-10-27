/**
 * What the conductor sees of a shared sketch's screen: the screening badge
 * ("Local screening" / "Cloud screening: Jev", wire contract X10, spec section
 * 8.10) and the Y4 banner ("Your screen failed N guest requests", spec section
 * 8.9). The Sketch tab header shows both; the Room panel mounts the same two.
 *
 * The badge shows the room's value as the server holds it, which is what
 * guests are told. The room only says `cloud`; the engine and its host are
 * read from main's consent module while the value is `cloud`, and read again
 * on every screening change.
 */

import React from 'react';
import type { Theme } from '../../types';
import {
	cloudEngineOfSource,
	sketchCloudEngineWhere,
	SKETCH_CLOUD_SCREENING_GUEST_BADGE,
	type SketchCloudEngine,
} from '../../../shared/sketch/cloud-consent';
import type { Screening } from '../../../shared/sketch/protocol';
import {
	sketchScreenOutageBanner,
	sketchScreenOutageTotal,
	sketchScreeningBadgeLabel,
	type SketchRoomStats,
} from '../../../shared/sketch/room-stats';
import { MiniBadge } from '../ui/MiniBadge';

interface CloudScreeningEngine {
	engine: SketchCloudEngine;
	host?: string;
}

/** The cloud engine in force and its host, while `active`; null otherwise or when it cannot be read. */
function useCloudScreeningEngine(active: boolean): CloudScreeningEngine | null {
	const [engine, setEngine] = React.useState<CloudScreeningEngine | null>(null);

	React.useEffect(() => {
		if (!active) {
			setEngine(null);
			return;
		}
		let cancelled = false;
		const read = () => {
			window.maestro.sketch
				.screeningConsentStatus()
				.then((status) => {
					if (cancelled) return;
					const found = status.source ? cloudEngineOfSource(status.source) : null;
					setEngine(found ? { engine: found, host: status.source?.host } : null);
				})
				// Sketch Book turned off, or main not ready: the badge still says cloud.
				.catch(() => {
					if (!cancelled) setEngine(null);
				});
		};
		read();
		const unsubscribe = window.maestro.sketch.onScreeningChanged(read);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [active]);

	return engine;
}

export interface SketchScreeningBadgeProps {
	/** The room's screening value as the server holds it, or null before it has one. */
	screening: Screening | null;
	theme: Theme;
}

export function SketchScreeningBadge({ screening, theme }: SketchScreeningBadgeProps) {
	const cloud = useCloudScreeningEngine(screening === 'cloud');
	if (!screening) return null;
	const label = sketchScreeningBadgeLabel(screening, cloud?.engine ?? null);
	const title =
		screening === 'local'
			? 'Guest text is screened on this computer.'
			: `Guest text is screened by ${
					cloud ? sketchCloudEngineWhere(cloud.engine, cloud.host) : 'a cloud service'
				}. Guests see "${SKETCH_CLOUD_SCREENING_GUEST_BADGE}".`;
	return (
		<MiniBadge
			label={label}
			theme={theme}
			color={screening === 'cloud' ? theme.colors.warning : theme.colors.success}
			title={title}
			testId="sketch-screening-badge"
		/>
	);
}

export interface SketchScreenOutageBannerProps {
	/** The room's newest `room.stats`, or null before one. */
	stats: SketchRoomStats | null;
	theme: Theme;
}

/** The Y4 banner. Renders nothing while every actor's `unavailableTotal` is 0. */
export function SketchScreenOutageBanner({ stats, theme }: SketchScreenOutageBannerProps) {
	const text = sketchScreenOutageBanner(sketchScreenOutageTotal(stats?.actors ?? []));
	if (!text) return null;
	return (
		<div
			className="px-3 py-1 text-xs select-text"
			role="status"
			data-sketch-screen-outage=""
			style={{ color: theme.colors.warning, borderBottom: `1px solid ${theme.colors.border}` }}
		>
			{text}
		</div>
	);
}
