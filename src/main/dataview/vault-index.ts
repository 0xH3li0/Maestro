/**
 * The Dataview index for ONE vault root (M2, D2, DV-3). It implements the vendored `FullIndex` contract, so
 * the vendored source resolver, query engine, and `PageMetadata.serialize` run against it unchanged:
 *
 * - `pages`: path to `PageMetadata`, built by `parsePage` (M1, the vendored parser, then M3 link resolution).
 * - `tags`: path to its tags plus their parent tags (`fullTags()`), with a case-insensitive inverse.
 * - `links`: path to its outlink paths; the inverse is the inlink index (`file.inlinks`).
 * - `prefix`: the folder index over every vault file, any extension.
 * - `metadataCache`, `vault`, `csv`, `starred`: the Obsidian services the engine reaches for.
 *
 * Indexing mirrors upstream `FullIndex.finish`; source resolution is upstream's `matchingSourcePaths`,
 * vendored as-is. File access goes through a `VaultFs`, so a local root and an SSH root index the same way.
 * See docs/agent-guides/DATAVIEW.md (section 2, "The `FullIndex` contract" and M2).
 */

import {
	IndexMap,
	ValueCaseInsensitiveIndexMap,
	VaultPaths,
	Result,
	buildResolvedLinks,
	createLinkResolver,
	matchingSourcePaths,
	parseCsv,
	parsePage,
	starredPathsFromBookmarks,
	type DataObject,
	type FullIndex,
	type LinkResolver,
	type PageMetadata,
	type PageParseWarning,
	type Source,
} from '../../shared/dataview';
import { yieldToEventLoop } from '../utils/concurrency';
import { logger } from '../utils/logger';
import type { VaultFileStat, VaultFs } from './vault-fs';

const LOG_CONTEXT = 'Dataview';

/** Files parsed per batch. The index yields to the event loop between batches so IPC keeps flowing. */
export const DATAVIEW_PARSE_BATCH_SIZE = 16;

/**
 * Pages larger than this are indexed with their `file.*` fields only (name, path, size, times): their
 * text is never read, so one huge export cannot stall the main thread.
 */
export const DATAVIEW_MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;

/** How long a parsed CSV source is reused before it is read again (upstream `CsvCache.CACHE_EXPIRY_SECONDS`). */
export const DATAVIEW_CSV_CACHE_MS = 5 * 60 * 1000;

/** Obsidian's Bookmarks core plugin file, the source of `file.starred`. */
const BOOKMARKS_PATH = '.obsidian/bookmarks.json';

/** One index change: the new revision and every page path whose data may differ. */
export interface VaultIndexChange {
	revision: number;
	changedPaths: string[];
}

export type VaultIndexListener = (change: VaultIndexChange) => void;

/** What the last full scan did. */
export interface VaultScanStats {
	pageCount: number;
	/** Pages indexed with `file.*` fields only because they exceed {@link DATAVIEW_MAX_INDEXED_FILE_BYTES}. */
	oversizedCount: number;
	/** Pages whose read failed (deleted mid-scan, permissions); they are left out. */
	failedCount: number;
	durationMs: number;
	finishedAt: number;
}

export interface VaultIndexOptions {
	/** Receives parse warnings (invalid frontmatter and similar). Defaults to a debug log line. */
	onWarning?: (warning: PageParseWarning) => void;
}

export class VaultIndex implements FullIndex {
	readonly pages = new Map<string, PageMetadata>();
	readonly tags = new ValueCaseInsensitiveIndexMap();
	readonly links = new IndexMap();
	revision = 0;

	prefix: VaultPaths = new VaultPaths();
	readonly csv: FullIndex['csv'];
	readonly starred: FullIndex['starred'];
	readonly metadataCache: FullIndex['metadataCache'];
	readonly vault: FullIndex['vault'];

	/** Stats of the last finished full scan, or null before the first one. */
	lastScan: VaultScanStats | null = null;

	private resolver: LinkResolver | null = null;
	private resolvedLinks: Record<string, Record<string, number>> | null = null;
	private stars = new Set<string>();
	private readonly csvCache = new Map<string, { data: DataObject[]; loadedAt: number }>();
	private readonly listeners = new Set<VaultIndexListener>();
	private scanInFlight: Promise<VaultScanStats> | null = null;
	private readonly onWarning: (warning: PageParseWarning) => void;

	constructor(
		readonly fs: VaultFs,
		options: VaultIndexOptions = {}
	) {
		this.onWarning =
			options.onWarning ??
			((warning) =>
				logger.debug(
					`Dataview parse warning in ${warning.path}:${warning.line + 1}: ${warning.message}`,
					LOG_CONTEXT
				));

		// The `FullIndex` members the vendored code reads as plain objects. Arrow functions keep `this`
		// stable however the engine calls them; the getter recomputes `resolvedLinks` only after a change.
		const resolvedLinkTable = () => this.resolvedLinkTable();
		this.csv = { get: (path) => this.loadCsv(path) };
		this.starred = { starred: (path) => this.stars.has(path) };
		this.metadataCache = {
			getFirstLinkpathDest: (linkpath, sourcePath) => {
				const target = this.linkResolver().resolve(linkpath, sourcePath);
				return target === null ? null : { path: target };
			},
			get resolvedLinks() {
				return resolvedLinkTable();
			},
		};
		this.vault = {
			getMarkdownFiles: () => Array.from(this.pages.keys(), (path) => ({ path })),
		};
	}

	/** The vault root as the platform spells it. */
	get root(): string {
		return this.fs.root;
	}

	getPage(path: string): PageMetadata | undefined {
		return this.pages.get(path);
	}

	/** Every page that links to `path` (the inlink index). */
	inlinks(path: string): string[] {
		return Array.from(this.links.getInverse(path));
	}

	/**
	 * The vault paths a query source matches: tags, folders, `[[link]]` (incoming) and `outgoing([[link]])`,
	 * `csv(...)`, and their `and`, `or`, and negation, exactly as upstream resolves them. `originFile` is the
	 * querying page, which relative links and CSV paths resolve against. A failure carries Dataview's error.
	 */
	pagesForSource(source: Source, originFile = ''): Result<Set<string>, string> {
		return matchingSourcePaths(source, this, originFile);
	}

	/** Subscribe to index changes. Returns the unsubscribe function. */
	onChange(listener: VaultIndexListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Read and parse the whole vault, then swap the result in as ONE change. Concurrent calls share one
	 * scan. Throws when the root cannot be listed; a single unreadable page is skipped and counted.
	 */
	scan(): Promise<VaultScanStats> {
		if (!this.scanInFlight) {
			this.scanInFlight = this.runScan().finally(() => {
				this.scanInFlight = null;
			});
		}
		return this.scanInFlight;
	}

	private async runScan(): Promise<VaultScanStats> {
		const startedAt = Date.now();
		const listing = await this.fs.list();

		// Links resolve against the new file set, so a page linking to a file added since the last scan
		// resolves on this pass.
		const paths = new VaultPaths(listing.files, listing.folders);
		const resolver = createLinkResolver(paths.allFiles());
		const markdown = listing.files.filter((file) => listing.stats.has(file));

		const parsed = new Map<string, PageMetadata>();
		let oversizedCount = 0;
		let failedCount = 0;
		for (let start = 0; start < markdown.length; start += DATAVIEW_PARSE_BATCH_SIZE) {
			const batch = markdown.slice(start, start + DATAVIEW_PARSE_BATCH_SIZE);
			const pages = await Promise.all(
				batch.map((path) => this.readAndParse(path, listing.stats.get(path)!, resolver))
			);
			pages.forEach((page, i) => {
				if (page === null) failedCount++;
				else {
					if (page.oversized) oversizedCount++;
					parsed.set(batch[i], page.page);
				}
			});
			await yieldToEventLoop();
		}
		const stars = await this.readStars();

		// Swap in. Every page set or removed counts as changed, plus every page whose star flipped.
		const changed = new Set<string>(parsed.keys());
		for (const path of this.pages.keys()) if (!parsed.has(path)) changed.add(path);
		for (const path of stars) if (!this.stars.has(path)) changed.add(path);
		for (const path of this.stars) if (!stars.has(path)) changed.add(path);

		this.pages.clear();
		this.tags.clear();
		this.links.clear();
		for (const [path, page] of parsed) this.indexPage(path, page);
		this.prefix = paths;
		this.resolver = resolver;
		this.stars = stars;
		this.csvCache.clear();

		const finishedAt = Date.now();
		this.lastScan = {
			pageCount: this.pages.size,
			oversizedCount,
			failedCount,
			durationMs: finishedAt - startedAt,
			finishedAt,
		};
		this.touch([...changed]);
		return this.lastScan;
	}

	/** Read one page and parse it; oversized pages skip the read. Null when the read fails. */
	private async readAndParse(
		path: string,
		stat: VaultFileStat,
		resolver: LinkResolver
	): Promise<{ page: PageMetadata; oversized: boolean } | null> {
		const oversized = stat.size > DATAVIEW_MAX_INDEXED_FILE_BYTES;
		let content = '';
		if (!oversized) {
			try {
				content = await this.fs.readText(path);
			} catch (error) {
				logger.debug(`Dataview skipped unreadable page ${path}: ${String(error)}`, LOG_CONTEXT);
				return null;
			}
		}
		const page = parsePage(
			{ path, content, ctime: stat.ctime, mtime: stat.mtime, size: stat.size },
			resolver,
			{ onWarning: this.onWarning }
		);
		return { page, oversized };
	}

	/** The starred paths from `.obsidian/bookmarks.json`; empty when it is missing or malformed. */
	private async readStars(): Promise<Set<string>> {
		let text: string;
		try {
			text = await this.fs.readText(BOOKMARKS_PATH);
		} catch {
			return new Set();
		}
		try {
			return starredPathsFromBookmarks(JSON.parse(text));
		} catch {
			return new Set();
		}
	}

	/** Upstream `FullIndex.finish`, after canonicalization: fill the tag and link indexes for one page. */
	private indexPage(path: string, page: PageMetadata): void {
		this.pages.set(path, page);
		this.tags.set(path, page.fullTags());
		this.links.set(path, new Set<string>(page.links.map((link) => link.path)));
	}

	/** Bump the revision and tell every listener which paths changed. */
	private touch(changedPaths: string[]): void {
		this.revision += 1;
		this.resolvedLinks = null;
		const change: VaultIndexChange = { revision: this.revision, changedPaths };
		for (const listener of [...this.listeners]) {
			try {
				listener(change);
			} catch (error) {
				// One broken subscriber must not starve the others; report it and keep going.
				logger.error(`Dataview change listener failed: ${String(error)}`, LOG_CONTEXT);
			}
		}
	}

	private linkResolver(): LinkResolver {
		if (!this.resolver) this.resolver = createLinkResolver(this.prefix.allFiles());
		return this.resolver;
	}

	private resolvedLinkTable(): Record<string, Record<string, number>> {
		if (!this.resolvedLinks) {
			this.resolvedLinks = buildResolvedLinks(this.pages, (path) => this.prefix.hasFile(path));
		}
		return this.resolvedLinks;
	}

	/**
	 * Upstream `CsvCache.get`, limited to files inside the vault (the guide's CSV trap): URL sources are
	 * refused, and only a path the scan listed is read, so a query cannot reach outside the root.
	 */
	private async loadCsv(path: string): Promise<Result<DataObject[], string>> {
		if (/^(https?|file):\/\//i.test(path)) {
			return Result.failure(
				`Loading CSV data from a URL is not supported in Maestro ('${path}'); use a CSV file inside the vault.`
			);
		}
		const now = Date.now();
		const cached = this.csvCache.get(path);
		if (cached && now - cached.loadedAt <= DATAVIEW_CSV_CACHE_MS)
			return Result.success(cached.data);

		if (!this.prefix.hasFile(path))
			return Result.failure(`Failed to load data from path '${path}'.`);
		try {
			const data = parseCsv(await this.fs.readText(path));
			this.csvCache.set(path, { data, loadedAt: now });
			return Result.success(data);
		} catch {
			return Result.failure(`Failed to load data from path '${path}'.`);
		}
	}
}
