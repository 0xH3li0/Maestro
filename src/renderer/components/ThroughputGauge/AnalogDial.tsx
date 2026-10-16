/**
 * AnalogDial - the Throughput Gauge's speedometer.
 *
 * A 270 degree arc with the open side at the bottom, a needle, tick labels, a
 * peak mark, and the reading in numbers underneath. The arc's maximum is not
 * fixed: it snaps to the next "nice" ceiling above the larger of the reading
 * and the peak (`niceGaugeMax`), so a 30 tok/s trickle and a 4k tok/s burst
 * both use the full sweep and the scale only moves when the peak does.
 *
 * Readings arrive four times a second, so the needle and the value arc ease
 * between them with a CSS transition rather than jumping.
 */

import { memo } from 'react';
import { formatNumber } from '../../../shared/formatters';
import { transparentize } from '../../../shared/colorContrast';
import type { Theme } from '../../types';

/** Smallest ceiling the dial ever shows, so an idle gauge still reads as a scale. */
const MIN_GAUGE_MAX = 50;
/** Ceilings run 1, 2.5, 5 per decade: each divides into five labeled steps. */
const NICE_STEPS = [1, 2.5, 5] as const;

/**
 * The dial's full-scale value: the smallest ceiling in the 50, 100, 250, 500,
 * 1k, 2.5k, 5k, ... sequence that is at least the larger of `value` and `peak`.
 */
export function niceGaugeMax(value: number, peak: number): number {
	const target = Math.max(value, peak, 0);
	if (!Number.isFinite(target)) return MIN_GAUGE_MAX;
	for (let magnitude = 10; ; magnitude *= 10) {
		for (const step of NICE_STEPS) {
			const ceiling = step * magnitude;
			if (ceiling >= MIN_GAUGE_MAX && ceiling >= target) return ceiling;
		}
	}
}

/** Sweep geometry, in SVG degrees (0 = +x, clockwise because y points down). */
const START_DEG = 135;
const SWEEP_DEG = 270;
const MAJOR_DIVISIONS = 5;

const VIEW_WIDTH = 200;
const VIEW_HEIGHT = 168;
const CX = 100;
const CY = 96;
const ARC_RADIUS = 78;
const ARC_WIDTH = 8;
const LABEL_RADIUS = 56;
const NEEDLE_LENGTH = 64;

/** Normalized path length, so the value arc is a plain dash of 0-100. */
const ARC_PATH_LENGTH = 100;

/** How long the needle eases between readings; matches the 250ms publish tick. */
const NEEDLE_TRANSITION = 'transform 240ms ease-out, stroke-dasharray 240ms ease-out';

function polar(deg: number, radius: number): { x: number; y: number } {
	const rad = (deg * Math.PI) / 180;
	return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

const arcStart = polar(START_DEG, ARC_RADIUS);
const arcEnd = polar(START_DEG + SWEEP_DEG, ARC_RADIUS);
/** The whole track. Large-arc flag 1: the sweep is more than half a circle. */
const ARC_PATH = `M ${arcStart.x} ${arcStart.y} A ${ARC_RADIUS} ${ARC_RADIUS} 0 1 1 ${arcEnd.x} ${arcEnd.y}`;

function fractionOf(value: number, max: number): number {
	if (!(max > 0) || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / max));
}

function angleOf(fraction: number): number {
	return START_DEG + SWEEP_DEG * fraction;
}

export interface AnalogDialProps {
	theme: Theme;
	/** Current reading, tokens per second. */
	value: number;
	/** Highest reading since the last reset, tokens per second. */
	peak: number;
	/** Unit under the number. */
	label?: string;
	/**
	 * Small line under the dial naming the metric and scope ("Out, all agents").
	 * HTML rather than SVG text, so a long agent name truncates instead of
	 * running off the card.
	 */
	caption?: string;
}

export const AnalogDial = memo(function AnalogDial({
	theme,
	value,
	peak,
	label = 'tok/s',
	caption,
}: AnalogDialProps) {
	const { colors } = theme;
	const max = niceGaugeMax(value, peak);
	const valueFraction = fractionOf(value, max);
	const peakFraction = fractionOf(peak, max);

	const trackColor = transparentize(colors.textDim, colors.bgSidebar, 0.25);
	const minorTickColor = transparentize(colors.textDim, colors.bgSidebar, 0.5);

	const majorTicks = Array.from({ length: MAJOR_DIVISIONS + 1 }, (_, index) => {
		const fraction = index / MAJOR_DIVISIONS;
		const angle = angleOf(fraction);
		return {
			key: index,
			outer: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 2),
			inner: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 9),
			label: polar(angle, LABEL_RADIUS),
			text: formatNumber((max * index) / MAJOR_DIVISIONS),
		};
	});
	const minorTicks = Array.from({ length: MAJOR_DIVISIONS }, (_, index) => {
		const angle = angleOf((index + 0.5) / MAJOR_DIVISIONS);
		return {
			key: index,
			outer: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 2),
			inner: polar(angle, ARC_RADIUS - ARC_WIDTH / 2 - 6),
		};
	});

	const peakAngle = angleOf(peakFraction);
	const peakOuter = polar(peakAngle, ARC_RADIUS + ARC_WIDTH / 2 + 3);
	const peakInner = polar(peakAngle, ARC_RADIUS - ARC_WIDTH / 2 - 1);

	const reading = formatNumber(Math.round(value));

	const dial = (
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			className="block w-full h-auto"
			role="meter"
			aria-label={`Throughput ${reading} ${label}`}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={Math.round(value)}
			data-testid="throughput-analog-dial"
			data-gauge-max={max}
		>
			<path
				d={ARC_PATH}
				fill="none"
				stroke={trackColor}
				strokeWidth={ARC_WIDTH}
				strokeLinecap="round"
			/>
			{/* The filled portion is the same path dashed to the reading, so it eases
			    with the needle instead of being rebuilt as a new arc each tick. */}
			<path
				d={ARC_PATH}
				fill="none"
				stroke={colors.accent}
				strokeWidth={ARC_WIDTH}
				strokeLinecap="round"
				pathLength={ARC_PATH_LENGTH}
				strokeDasharray={`${valueFraction * ARC_PATH_LENGTH} ${ARC_PATH_LENGTH}`}
				opacity={valueFraction > 0 ? 1 : 0}
				style={{ transition: NEEDLE_TRANSITION }}
			/>

			{minorTicks.map((tick) => (
				<line
					key={`minor-${tick.key}`}
					x1={tick.outer.x}
					y1={tick.outer.y}
					x2={tick.inner.x}
					y2={tick.inner.y}
					stroke={minorTickColor}
					strokeWidth={1}
				/>
			))}
			{majorTicks.map((tick) => (
				<g key={`major-${tick.key}`}>
					<line
						x1={tick.outer.x}
						y1={tick.outer.y}
						x2={tick.inner.x}
						y2={tick.inner.y}
						stroke={colors.textDim}
						strokeWidth={1.5}
					/>
					<text
						x={tick.label.x}
						y={tick.label.y}
						fill={colors.textDim}
						fontSize={9}
						textAnchor="middle"
						dominantBaseline="middle"
					>
						{tick.text}
					</text>
				</g>
			))}

			{peakFraction > 0 && (
				<line
					data-testid="throughput-dial-peak"
					x1={peakOuter.x}
					y1={peakOuter.y}
					x2={peakInner.x}
					y2={peakInner.y}
					stroke={colors.warning}
					strokeWidth={2.5}
					strokeLinecap="round"
				>
					<title>{`Peak ${formatNumber(Math.round(peak))} ${label}`}</title>
				</line>
			)}

			{/* Drawn pointing at 0 degrees and rotated, so a reading change is one
			    transform the browser can ease. */}
			<g
				style={{
					transform: `rotate(${angleOf(valueFraction)}deg)`,
					transformOrigin: `${CX}px ${CY}px`,
					transformBox: 'view-box',
					transition: NEEDLE_TRANSITION,
				}}
			>
				<line
					x1={CX - 10}
					y1={CY}
					x2={CX + NEEDLE_LENGTH}
					y2={CY}
					stroke={colors.textMain}
					strokeWidth={2.5}
					strokeLinecap="round"
				/>
			</g>
			<circle cx={CX} cy={CY} r={5.5} fill={colors.accent} />
			<circle cx={CX} cy={CY} r={2} fill={colors.bgSidebar} />

			<text
				x={CX}
				y={CY + 44}
				fill={colors.textMain}
				fontSize={22}
				fontWeight={600}
				textAnchor="middle"
				data-testid="throughput-dial-reading"
			>
				{reading}
			</text>
			<text x={CX} y={CY + 60} fill={colors.textDim} fontSize={9} textAnchor="middle">
				{label}
			</text>
		</svg>
	);

	if (!caption) return dial;
	return (
		<div className="w-full min-w-0 flex flex-col items-center">
			{dial}
			<div
				className="max-w-full truncate text-2xs leading-tight"
				style={{ color: colors.textDim }}
				title={caption}
				data-testid="throughput-dial-caption"
			>
				{caption}
			</div>
		</div>
	);
});
