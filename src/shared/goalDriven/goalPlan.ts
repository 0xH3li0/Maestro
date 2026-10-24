/**
 * The Plan Doc of a Goal-Driven Auto Run: parse, render, create, and read the
 * agent's proposed Plan out of its `<!-- maestro:plan -->` marker block.
 *
 * A goal run keeps its plan in one Markdown file (see
 * `.maestro/scratch/goal-live-plan.md`). The human edits it in the Auto Run
 * editor at any time, and the engine rewrites it at every iteration boundary.
 * Both of those mean this module sits between a person's typing and a file
 * the engine overwrites, so its first rule is: never lose human text. Every
 * line the parser does not model (an unknown section, a paragraph inside the
 * Plan, an extra front-matter key) is carried in `doc.preserved` and put back
 * where it was on render.
 *
 * The second rule is a stable round trip. `renderGoalPlanDoc` writes one
 * canonical layout, and `renderGoalPlanDoc(parseGoalPlanDoc(x))` returns `x`
 * byte for byte when `x` is already canonical. Without that, every engine
 * write would reflow the file under the human's cursor even when nothing
 * changed. Non-canonical input (CRLF, `* [X]`, extra blank lines, sections
 * out of order) is normalized, never rejected.
 *
 * Parsing is regex-based and dependency-free, like `goalMarkers.ts`: no
 * markdown or YAML library. Fenced code blocks are respected through
 * `forEachMarkdownLine`, so a `## ` or `- [ ]` inside a fence stays text.
 */

import { forEachMarkdownLine } from '../markdownTaskScan';
import { lastPlanBlockBody } from './goalMarkers';
import type {
	GoalPlanDoc,
	GoalPlanExtraSection,
	GoalPlanFreeText,
	GoalPlanFrontMatter,
	GoalPlanItem,
	GoalPlanSectionKey,
	GoalPlanStatus,
	GoalRunConfig,
} from './types';

/** Owned sections in canonical render order, with their exact headings. */
const SECTION_HEADINGS: ReadonlyArray<readonly [GoalPlanSectionKey, string]> = [
	['goal', '## Goal'],
	['exitCriteria', '## Exit Criteria'],
	['plan', '## Plan'],
	['conductorNotes', '## Conductor Notes'],
	['iterationLog', '## Iteration Log'],
];

const GOAL_PLAN_STATUSES: readonly GoalPlanStatus[] = [
	'running',
	'paused',
	'done',
	'deadlock',
	'stalled',
	'stopped',
];

/** A `## ` heading line (exactly two hashes; `###` stays body text). */
const SECTION_HEADING_RE = /^##[ \t]+(.*?)[ \t]*$/;

/** A front-matter `key: value` line. */
const FRONT_MATTER_LINE_RE = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/;

/**
 * A Plan checkbox line: indentation, bullet, `[ ]` or `[x]`, then the rest.
 * The rest may be empty (`- [ ]` typed but not yet filled in).
 */
const PLAN_ITEM_RE = /^([ \t]*)[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;

/**
 * The trailing identity comment of a Plan item:
 * `<!-- id:a2 by:agent it:2 -->`. `id:` comes first; the other `key:value`
 * tokens may appear in any order and unknown keys are ignored.
 */
const ITEM_META_RE = /[ \t]*<!--[ \t]*(id:[^\s>]*(?:[ \t]+[A-Za-z]+:[^\s>]*)*)[ \t]*-->[ \t]*$/;

/** A human-assigned id, `h<n>`. */
const HUMAN_ID_RE = /^h\d+$/;

/** One parsed Plan line, before ids are resolved against the whole list. */
interface PlanLine {
	/** Indentation width in columns; depth is derived by the caller. */
	indent: number;
	checked: boolean;
	text: string;
	/** Explicit id from the meta comment, `null` when absent or `id:new`. */
	id: string | null;
	author: GoalPlanItem['author'] | null;
	iteration: number | null;
}

/**
 * Parse one Plan checkbox line. Returns `null` for anything that is not an
 * item, including an empty checkbox with no id, which is a human still typing.
 */
function parsePlanLine(line: string): PlanLine | null {
	const match = PLAN_ITEM_RE.exec(line);
	if (!match) return null;

	let rest = match[3] ?? '';
	let id: string | null = null;
	let author: PlanLine['author'] = null;
	let iteration: number | null = null;
	const meta = ITEM_META_RE.exec(rest);
	if (meta) {
		rest = rest.slice(0, meta.index);
		for (const token of meta[1].split(/[ \t]+/)) {
			const colon = token.indexOf(':');
			const key = token.slice(0, colon);
			const value = token.slice(colon + 1);
			if (key === 'id') id = value && value !== 'new' ? value : null;
			else if (key === 'by' && (value === 'agent' || value === 'human')) author = value;
			else if (key === 'it' && /^\d+$/.test(value)) iteration = Number(value);
		}
	}

	const text = rest.trim();
	if (!text && id === null) return null;

	return {
		indent: indentWidth(match[1]),
		checked: match[2] !== ' ',
		text,
		id,
		author,
		iteration,
	};
}

/** Indentation width in columns; a tab counts as one depth level (two). */
function indentWidth(indent: string): number {
	let width = 0;
	for (const char of indent) width += char === '\t' ? 2 : 1;
	return width;
}

/** Two columns per depth level. */
function depthOf(indent: number): number {
	return Math.floor(indent / 2);
}

/**
 * A source of fresh `<prefix><n>` ids that never collide with `taken`: each
 * call returns one past the highest number already used under that prefix.
 * Numbers are never reused, so an id a merge dropped cannot come back as a
 * different item.
 */
function freshIdAllocator(prefix: 'a' | 'h', taken: Iterable<string>): () => string {
	const own = new RegExp(`^${prefix}(\\d+)$`);
	let next = 0;
	for (const id of taken) {
		const match = own.exec(id);
		if (match) next = Math.max(next, Number(match[1]));
	}
	return () => `${prefix}${++next}`;
}

/** Render one Plan item in canonical form. */
function renderPlanItem(item: GoalPlanItem): string {
	const iteration = item.iteration === null ? '' : ` it:${item.iteration}`;
	const text = item.text ? `${item.text} ` : '';
	return `${'  '.repeat(item.depth)}- [${item.checked ? 'x' : ' '}] ${text}<!-- id:${item.id} by:${item.author}${iteration} -->`;
}

/** Drop leading and trailing blank lines; inner blank lines are content. */
function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === '') start++;
	while (end > start && lines[end - 1].trim() === '') end--;
	return lines.slice(start, end);
}

/** Indices of the lines of `text` that sit outside fenced code blocks. */
function unfencedLineIndices(text: string): Set<number> {
	const indices = new Set<number>();
	forEachMarkdownLine(text, (_line, index) => {
		indices.add(index);
	});
	return indices;
}

/** Strip a trailing YAML comment and surrounding quotes from a scalar. */
function frontMatterScalar(raw: string): string {
	const value = raw.replace(/[ \t]+#.*$/, '').trim();
	const quoted = /^(["'])(.*)\1$/.exec(value);
	return quoted ? quoted[2] : value;
}

/** A non-negative integer, or `fallback` when `value` is not one. */
function nonNegativeInt(value: string, fallback: number): number {
	return /^\d+$/.test(value) ? Number(value) : fallback;
}

interface ParsedFrontMatter {
	frontMatter: GoalPlanFrontMatter;
	extraLines: string[];
	body: string;
}

/**
 * Split off and read the front matter. A file with no front matter (or an
 * unclosed one) is all body, and the engine keys fall back to defaults the
 * next engine write replaces.
 *
 * `max-iterations` is the one key the human edits, so a value that is not a
 * positive integer (`null`, `none`, empty, a typo) reads as "no cap" rather
 * than failing the run; `GOAL_RUN_HARD_ITERATION_CAP` still bounds it.
 */
function parseFrontMatter(text: string): ParsedFrontMatter {
	const frontMatter: GoalPlanFrontMatter = {
		goalRun: '',
		status: 'running',
		iteration: 0,
		maxIterations: null,
		progress: 0,
		updated: '',
	};
	const extraLines: string[] = [];

	const lines = text.split('\n');
	const close =
		lines[0] === '---' ? lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---') : -1;
	if (close === -1) {
		return { frontMatter, extraLines, body: text };
	}

	for (const line of lines.slice(1, close)) {
		const match = FRONT_MATTER_LINE_RE.exec(line);
		const value = match ? frontMatterScalar(match[2]) : '';
		switch (match?.[1]) {
			case 'goal-run':
				frontMatter.goalRun = value;
				break;
			case 'status':
				if ((GOAL_PLAN_STATUSES as readonly string[]).includes(value)) {
					frontMatter.status = value as GoalPlanStatus;
				}
				break;
			case 'iteration':
				frontMatter.iteration = nonNegativeInt(value, 0);
				break;
			case 'max-iterations': {
				const cap = nonNegativeInt(value, 0);
				frontMatter.maxIterations = cap > 0 ? cap : null;
				break;
			}
			case 'progress':
				frontMatter.progress = Math.min(100, nonNegativeInt(value, 0));
				break;
			case 'updated':
				frontMatter.updated = value;
				break;
			default:
				extraLines.push(line);
		}
	}

	return { frontMatter, extraLines, body: lines.slice(close + 1).join('\n') };
}

/**
 * Read the Plan section body into items plus the free text around them.
 *
 * Ids resolve in two passes because a missing id gets the NEXT FREE `h<n>`,
 * which depends on every explicit id in the list, including ones further
 * down. A repeated id (the human copy-pasted a line, comment and all) keeps
 * its first holder; the copy is a new human item, since only the human can
 * have made it.
 */
function parsePlanBody(body: string): { items: GoalPlanItem[]; planText: GoalPlanFreeText[] } {
	const lines = body ? body.split('\n') : [];
	const unfenced = unfencedLineIndices(body);
	const parsed = lines.map((line, i) => (unfenced.has(i) ? parsePlanLine(line) : null));

	const nextHumanId = freshIdAllocator(
		'h',
		parsed.flatMap((entry) => (entry?.id ? [entry.id] : []))
	);

	const items: GoalPlanItem[] = [];
	const planText: GoalPlanFreeText[] = [];
	const seen = new Set<string>();
	let anchor: string | null = null;

	lines.forEach((line, i) => {
		const entry = parsed[i];
		if (!entry) {
			const last = planText[planText.length - 1];
			if (last && last.afterId === anchor) last.text += `\n${line}`;
			else planText.push({ afterId: anchor, text: line });
			return;
		}

		let item: GoalPlanItem;
		if (entry.id !== null && !seen.has(entry.id)) {
			item = {
				id: entry.id,
				text: entry.text,
				checked: entry.checked,
				depth: depthOf(entry.indent),
				author: entry.author ?? (HUMAN_ID_RE.test(entry.id) ? 'human' : 'agent'),
				iteration: entry.iteration,
			};
		} else {
			item = {
				id: nextHumanId(),
				text: entry.text,
				checked: entry.checked,
				depth: depthOf(entry.indent),
				author: 'human',
				iteration: null,
			};
		}
		seen.add(item.id);
		items.push(item);
		anchor = item.id;
	});

	return { items, planText };
}

/** Render the Plan body: items in order, each followed by its free text. */
function renderPlanBody(doc: GoalPlanDoc): string {
	const textByAnchor = new Map<string | null, string[]>();
	for (const entry of doc.preserved.planText) {
		const group = textByAnchor.get(entry.afterId) ?? [];
		group.push(entry.text);
		textByAnchor.set(entry.afterId, group);
	}

	const lines: string[] = [...(textByAnchor.get(null) ?? [])];
	const itemIds = new Set<string>();
	for (const item of doc.items) {
		itemIds.add(item.id);
		lines.push(renderPlanItem(item), ...(textByAnchor.get(item.id) ?? []));
	}
	// Text anchored to an item that no longer exists (the merge dropped it)
	// is still human text: keep it, at the end.
	for (const [anchor, group] of textByAnchor) {
		if (anchor !== null && !itemIds.has(anchor)) lines.push(...group);
	}
	return lines.join('\n');
}

/**
 * Parse a Plan Doc. Never throws: a missing section reads as empty, a
 * missing front matter reads as defaults, and anything unrecognized lands in
 * `doc.preserved`.
 *
 * A Plan line with no id comment is an item the human typed in the editor;
 * it gets the next free `h<n>` id and `by:human`. The ids are stable from
 * the first engine write onward, because the render writes them into the
 * file.
 */
export function parseGoalPlanDoc(text: string): GoalPlanDoc {
	const normalized = text.replace(/\r\n?/g, '\n');
	const { frontMatter, extraLines, body } = parseFrontMatter(normalized);

	const bodyLines = body.split('\n');
	const unfenced = unfencedLineIndices(body);
	const owned = new Map<GoalPlanSectionKey, string>();
	const extraSections: GoalPlanExtraSection[] = [];
	const preambleLines: string[] = [];

	let current: { heading: string; key: GoalPlanSectionKey | null; lines: string[] } | null = null;
	let lastOwned: GoalPlanSectionKey | null = null;

	const close = () => {
		if (!current) return;
		const sectionBody = trimBlankLines(current.lines).join('\n');
		if (current.key) {
			owned.set(current.key, sectionBody);
			lastOwned = current.key;
		} else {
			extraSections.push({ heading: current.heading, body: sectionBody, after: lastOwned });
		}
	};

	bodyLines.forEach((line, i) => {
		const heading = unfenced.has(i) ? SECTION_HEADING_RE.exec(line) : null;
		if (!heading) {
			(current ? current.lines : preambleLines).push(line);
			return;
		}
		close();
		const title = heading[1].toLowerCase();
		const known = SECTION_HEADINGS.find(([, h]) => h.slice(3).toLowerCase() === title)?.[0] ?? null;
		// A second `## Plan` is not merged into the first: it is kept verbatim
		// as an unknown section, so nothing the human typed is reinterpreted.
		const key = known && !owned.has(known) ? known : null;
		current = { heading: line, key, lines: [] };
	});
	close();

	const { items, planText } = parsePlanBody(owned.get('plan') ?? '');
	const iterationLog = (owned.get('iterationLog') ?? '')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => line.replace(/^[-*+][ \t]+/, ''));

	return {
		frontMatter,
		goal: owned.get('goal') ?? '',
		exitCriteria: owned.get('exitCriteria') ?? '',
		items,
		conductorNotes: owned.get('conductorNotes') ?? '',
		iterationLog,
		preserved: {
			frontMatterLines: extraLines,
			preamble: trimBlankLines(preambleLines).join('\n'),
			sections: extraSections,
			planText,
		},
	};
}

/**
 * Render a Plan Doc in canonical form: the six engine keys, then preserved
 * front-matter lines; one blank line between blocks; owned sections in fixed
 * order with each unknown section after the owned one it followed; a single
 * trailing newline.
 */
export function renderGoalPlanDoc(doc: GoalPlanDoc): string {
	const fm = doc.frontMatter;
	const frontMatterLines = [
		`goal-run: ${fm.goalRun}`,
		`status: ${fm.status}`,
		`iteration: ${fm.iteration}`,
		`max-iterations: ${fm.maxIterations ?? 'null'}`,
		`progress: ${fm.progress}`,
		`updated: ${fm.updated}`,
		...doc.preserved.frontMatterLines,
	];

	const block = (heading: string, body: string) => (body ? `${heading}\n${body}` : heading);
	const blocks: string[] = [];
	if (doc.preserved.preamble) blocks.push(doc.preserved.preamble);
	const pushExtras = (after: GoalPlanSectionKey | null) => {
		for (const section of doc.preserved.sections) {
			if (section.after === after) blocks.push(block(section.heading, section.body));
		}
	};

	const bodies: Record<GoalPlanSectionKey, string> = {
		goal: doc.goal,
		exitCriteria: doc.exitCriteria,
		plan: renderPlanBody(doc),
		conductorNotes: doc.conductorNotes,
		iterationLog: doc.iterationLog.map((line) => `- ${line}`).join('\n'),
	};

	pushExtras(null);
	for (const [key, heading] of SECTION_HEADINGS) {
		blocks.push(block(heading, bodies[key]));
		pushExtras(key);
	}

	return `---\n${frontMatterLines.join('\n')}\n---\n\n${blocks.join('\n\n')}\n`;
}

/**
 * Demote `## ` headings in user text to `### ` so a goal written with its
 * own subsections cannot split the Plan Doc into unintended sections.
 * Fenced code is left alone.
 */
function demoteSectionHeadings(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const unfenced = unfencedLineIndices(text);
	return lines
		.map((line, i) => (unfenced.has(i) && SECTION_HEADING_RE.test(line) ? `#${line}` : line))
		.join('\n');
}

/** The Plan Doc for a fresh run: config text, an empty plan, iteration 0. */
export function createGoalPlanDoc(config: GoalRunConfig, runId: string, now: Date): GoalPlanDoc {
	return {
		frontMatter: {
			goalRun: runId,
			status: 'running',
			iteration: 0,
			maxIterations: config.maxIterations,
			progress: 0,
			updated: now.toISOString(),
		},
		goal: demoteSectionHeadings(config.goal.trim()),
		exitCriteria: demoteSectionHeadings(config.exitCriteria.trim()),
		items: [],
		conductorNotes: '',
		iterationLog: [],
		preserved: { frontMatterLines: [], preamble: '', sections: [], planText: [] },
	};
}

/**
 * Read the agent's proposed Plan from the LAST `<!-- maestro:plan -->` ...
 * `<!-- /maestro:plan -->` block in one iteration's output (the block grammar
 * lives in `goalMarkers.ts`, next to the other markers). Returns `null` when
 * there is no closed block or no line in it parses as an item, which the
 * engine treats as "the agent proposed nothing": the Plan stays as it was.
 *
 * Only checkbox lines count; prose the agent wrote inside the block is not
 * plan content and is dropped. Depth is measured from the shallowest item in
 * the block, because agents indent the whole list when it sits under a
 * numbered step or a quote.
 *
 * An item with `id:new` or no id is one the agent is adding: it gets the next
 * fresh `a<n>` and `by:agent`. Pass the ids already in the Plan Doc as
 * `reservedIds` so a fresh id never lands on an existing (or deleted-then-
 * remembered) item, which the merge would read as a reword of that item. A
 * repeated id keeps its first holder and the copy becomes a new agent item.
 *
 * An explicit `by:` on an existing id is the agent's claim, not the truth:
 * the merge takes authorship from the doc, never from this list.
 */
export function parsePlanMarker(
	agentText: string,
	reservedIds: Iterable<string> = []
): GoalPlanItem[] | null {
	const body = lastPlanBlockBody(agentText);
	if (body === null) return null;

	const entries = body
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.flatMap((line) => {
			const entry = parsePlanLine(line);
			return entry ? [entry] : [];
		});
	if (entries.length === 0) return null;

	const nextAgentId = freshIdAllocator('a', [
		...reservedIds,
		...entries.flatMap((entry) => (entry.id ? [entry.id] : [])),
	]);
	const baseIndent = Math.min(...entries.map((entry) => entry.indent));
	const seen = new Set<string>();

	return entries.map((entry): GoalPlanItem => {
		const id = entry.id !== null && !seen.has(entry.id) ? entry.id : nextAgentId();
		seen.add(id);
		const fresh = id !== entry.id;
		return {
			id,
			text: entry.text,
			checked: entry.checked,
			depth: depthOf(entry.indent - baseIndent),
			author: fresh ? 'agent' : (entry.author ?? (HUMAN_ID_RE.test(id) ? 'human' : 'agent')),
			iteration: fresh ? null : entry.iteration,
		};
	});
}
