/**
 * The one import site for Maestro's vendored Dataview core (D1, DV-2). Everything outside
 * `src/shared/dataview/` imports from here, never from `./vendor/` directly, so an upstream
 * bump only has to keep this surface stable. See docs/agent-guides/DATAVIEW.md.
 */

export {
	Link,
	Values,
	Groupings,
	Widget,
	Widgets,
	ListPairWidget,
	ExternalLinkWidget,
} from './vendor/data-model/value';
export type {
	DataObject,
	Literal,
	LiteralType,
	LiteralRepr,
	WrappedLiteral,
	Grouping,
	GroupElement,
} from './vendor/data-model/value';
export { Result, Success, Failure } from './vendor/api/result';
export { DEFAULT_QUERY_SETTINGS } from './vendor/settings';
export type { QuerySettings } from './vendor/settings';
