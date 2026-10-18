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
export { DataArray } from './vendor/api/data-array';
export type { ArrayFunc, ArrayComparator, LowestKey, Ingrouped } from './vendor/api/data-array';
export { DEFAULT_QUERY_SETTINGS } from './vendor/settings';
export type { QuerySettings } from './vendor/settings';
export { DataviewSettings } from './settings';

export { parseQuery } from './vendor/query/parse';
export { QueryFields } from './vendor/query/query';
export type {
	Query,
	QueryType,
	QueryHeader,
	QueryOperation,
	QuerySortBy,
	NamedField,
	ListQuery,
	TableQuery,
	TaskQuery,
	CalendarQuery,
	WhereStep,
	SortByStep,
	LimitStep,
	FlattenStep,
	GroupStep,
	ExtractStep,
} from './vendor/query/query';
export { parseField, EXPRESSION } from './vendor/expression/parse';
export { Fields } from './vendor/expression/field';
export type {
	Field,
	BinaryOp,
	CompareOp,
	ArithmeticOp,
	LiteralField,
	VariableField,
	ListField,
	ObjectField,
	BinaryOpField,
	FunctionField,
	LambdaField,
	IndexField,
	NegatedField,
} from './vendor/expression/field';
export { Sources } from './vendor/data-index/source';
export type {
	Source,
	SourceOp,
	TagSource,
	CsvSource,
	FolderSource,
	LinkSource,
	NegatedSource,
	EmptySource,
	BinaryOpSource,
} from './vendor/data-index/source';

export { Context } from './vendor/expression/context';
export type { LinkHandler } from './vendor/expression/context';
export { DEFAULT_FUNCTIONS } from './vendor/expression/functions';
export type { FunctionImpl } from './vendor/expression/functions';
export { evaluateField, UNRESOLVED_LINK_HANDLER } from './evaluate';

export { PageMetadata, ListItem } from './vendor/data-model/markdown';
export { Transferable } from './vendor/data-model/transferable';
export { dataviewJsonReplacer, dataviewJsonReviver } from './json';
export { parsePage, parseRawPage, finishPage } from './page';
export type { PageInput, PageParseWarning, ParsePageOptions } from './page';
export { extractMetadata } from './metadata';
export type { ExtractedMetadata, MetadataWarning } from './metadata';
export { createLinkResolver, linkTargetKeys, linkPathKey } from './resolve';
export type { LinkResolver } from './resolve';

export { matchingSourcePaths } from './vendor/data-index/resolver';
export { IndexMap, ValueCaseInsensitiveIndexMap, PathFilters } from './vendor/data-index/index';
export type { FullIndex, StarredEntry } from './vendor/data-index/index';
export { parseCsv } from './vendor/data-import/csv';
export {
	VaultPaths,
	isMarkdownPagePath,
	starredPathsFromBookmarks,
	buildResolvedLinks,
} from './vault';
