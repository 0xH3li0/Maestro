/**
 * The Dataview wire types (D2): what a query result looks like when it crosses IPC, the WS bridge,
 * or `maestro-cli --json`, and the index contract the query engine runs against.
 *
 * A result is plain JSON. Every value inside it went through `toWireValue()` (`./wire.ts`), which
 * uses upstream's `Transferable` codec for dates, durations, and links, so `reviveDataviewResult()`
 * on the other side turns them back into luxon `DateTime` and `Duration` and Dataview `Link` values.
 */

import type { FullIndex } from './vendor/data-index/index';
import type { IdentifierMeaning } from './vendor/query/engine';
import type { Literal } from './vendor/data-model/value';

/**
 * What the vendored engine reads from an index. DATAVIEW-05 asked for a narrow reader with
 * `getPage`, `pagesForSource`, and `resolveLink`; the vendored engine, source resolver, and
 * `PageMetadata.serialize` read the 9 members of upstream's `FullIndex` contract instead, so the
 * reader IS that contract (DEV-3 in docs/agent-guides/DATAVIEW.md). `VaultIndex` implements it in
 * main and adds the three methods as conveniences.
 */
export type DataviewIndexReader = FullIndex;

/** Where a row id came from: a page path, or a `GROUP BY` key (nested once per group step). */
export type DataviewIdMeaning = IdentifierMeaning;

/** A JSON value. Dates, durations, links, and widgets inside it carry a type tag (see `./wire.ts`). */
export type DataviewWireValue =
	| null
	| boolean
	| number
	| string
	| DataviewWireValue[]
	| { [key: string]: DataviewWireValue };

/**
 * Tasks as a `TASK` query returns them: a flat list, or one level of `{ key, rows }` per `GROUP BY`.
 * Each task is the task's own serialized fields (`text`, `line`, `status`, `completed`, `children`,
 * ...), without the page fields the engine copies onto it for `WHERE` and `SORT`.
 */
export type DataviewTaskGroups<V> = V[] | { key: V; rows: DataviewTaskGroups<V> }[];

interface DataviewRowsResultBase {
	/**
	 * Rows the engine skipped because an expression failed on them (upstream drops those rows
	 * silently). One line per query step that skipped any. Empty when nothing was skipped.
	 */
	warnings: string[];
	idMeaning: DataviewIdMeaning;
}

export interface DataviewTableResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'table';
	/** Column names; the id column (`File`, or the group name) comes first unless `WITHOUT ID`. */
	headers: string[];
	rows: V[][];
}

export interface DataviewListResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'list';
	/** One per row: the id, the formatted value, or a list-pair widget (`id: value`). */
	items: V[];
}

export interface DataviewTaskResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'task';
	groups: DataviewTaskGroups<V>;
}

/** A query type Maestro parses but does not render (`CALENDAR`, DV-1). */
export interface DataviewUnsupportedResult {
	kind: 'unsupported';
	feature: 'CALENDAR';
}

/** A parse or execution error, with Dataview's own text (DV-9). */
export interface DataviewErrorResult {
	kind: 'error';
	message: string;
	/** For a parse error: the 1-based line of the query source the parser stopped on. */
	line?: number;
}

/** The result of one `dataview` block. `V` is the wire form until `reviveDataviewResult()` runs. */
export type DataviewResult<V = DataviewWireValue> =
	| DataviewTableResult<V>
	| DataviewListResult<V>
	| DataviewTaskResult<V>
	| DataviewUnsupportedResult
	| DataviewErrorResult;

/** The same result with Dataview values (dates, durations, links, widgets) restored. */
export type RevivedDataviewResult = DataviewResult<Literal>;

/** The value of one inline `` `= expr` ``. */
export interface DataviewValueResult<V = DataviewWireValue> {
	kind: 'value';
	value: V;
}

/** The result of one inline `` `= expr` ``. */
export type DataviewInlineResult<V = DataviewWireValue> =
	| DataviewValueResult<V>
	| DataviewErrorResult;

export type RevivedDataviewInlineResult = DataviewInlineResult<Literal>;
