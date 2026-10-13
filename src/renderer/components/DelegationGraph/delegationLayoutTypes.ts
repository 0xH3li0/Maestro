/**
 * The Delegation Graph's layout vocabulary.
 *
 * A leaf module on purpose, the same way `DocumentGraph/layoutTypes.ts` is. The
 * toolbar picker, the cycle shortcut, and the settings validator all import the
 * union from here, so a key press, a click, and what reaches disk cannot
 * disagree about which layouts exist.
 *
 * It imports nothing. The layout engine pulls in d3-force, and the settings
 * store needs only the names.
 */

/** Available layout types for the Delegation Graph */
export type DelegationLayoutType = 'hierarchical' | 'force' | 'radial' | 'manual';

/**
 * The layouts an algorithm computes. `manual` is not one of them: it is the
 * state a scope enters when the user drags a node, and it means "leave every
 * node where it was put".
 */
export type DelegationAlgorithmLayout = Exclude<DelegationLayoutType, 'manual'>;

/** Display labels for layout types */
export const DELEGATION_LAYOUT_LABELS: Record<
	DelegationLayoutType,
	{ name: string; description: string }
> = {
	hierarchical: { name: 'Hierarchical', description: 'Top-down rows' },
	force: { name: 'Force', description: 'Physics simulation' },
	radial: { name: 'Radial', description: 'Concentric rings' },
	manual: { name: 'Manual', description: 'Where you placed them' },
};

/**
 * Every layout, in toolbar order. The settings validator reads this list, so
 * `manual` is in it: a hand-arranged scope must survive the trip to disk.
 */
export const DELEGATION_LAYOUT_TYPES: readonly DelegationLayoutType[] = [
	'hierarchical',
	'force',
	'radial',
	'manual',
];

/** The layouts a user can ask for by name, in cycle order. */
export const DELEGATION_ALGORITHM_LAYOUTS: readonly DelegationAlgorithmLayout[] = [
	'hierarchical',
	'force',
	'radial',
];

/** The layout a scope gets before the user has picked or dragged anything. */
export const DEFAULT_DELEGATION_LAYOUT: DelegationAlgorithmLayout = 'hierarchical';

/**
 * The layout after `current`, wrapping at the end of the list.
 *
 * The cycle visits the algorithms only. Nothing can cycle INTO `manual`, since
 * there is no arrangement to apply until a node has been dragged, and cycling
 * out of it starts again at the first algorithm.
 */
export function nextDelegationLayout(current: DelegationLayoutType): DelegationAlgorithmLayout {
	// `manual` and an unrecognized value both miss the list, so both restart the
	// cycle rather than sticking on themselves.
	const index = DELEGATION_ALGORITHM_LAYOUTS.indexOf(current as DelegationAlgorithmLayout);
	return DELEGATION_ALGORITHM_LAYOUTS[(index + 1) % DELEGATION_ALGORITHM_LAYOUTS.length];
}

/** True when `value` names a layout this build knows how to draw. */
export function isDelegationLayoutType(value: unknown): value is DelegationLayoutType {
	return DELEGATION_LAYOUT_TYPES.includes(value as DelegationLayoutType);
}

/** True when `layout` is computed by an algorithm rather than placed by hand. */
export function isDelegationAlgorithmLayout(
	layout: DelegationLayoutType
): layout is DelegationAlgorithmLayout {
	return layout !== 'manual';
}
