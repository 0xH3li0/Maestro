/**
 * Markdown helpers safe to use from both main and renderer.
 *
 * Kept dependency-free (no DOMPurify, no React) so this module can be imported
 * from main-process code paths like Cue history recording.
 */

// A table row is a line wrapped in pipes (| col | col |); a separator is a
// pipe/dash/colon-only line (|---|:--:|). Shared by stripMarkdown(), which
// drops both, and flattenMarkdownTables(), which keeps the rows' cell text, so
// the two cannot disagree about what a table is.
const TABLE_ROW_LINE = /^[ \t]*\|.*\|[ \t]*$/gm;
const TABLE_SEPARATOR_LINE = /^[ \t]*(?=.*\|)[ \t:|-]*-{2,}[ \t:|-]*$/gm;

/**
 * Strip markdown formatting to plain text.
 *
 * Removes code blocks, inline code, bold/italic, headers, blockquotes,
 * horizontal rules, links, images, strikethrough, tables, and normalizes
 * lists. Table grids in particular must never reach list/preview views (e.g.
 * the History list) where raw `| col | col |` pipes render as garbage.
 */
export const stripMarkdown = (text: string): string => {
	return (
		text
			// Remove code blocks (```...```) - keep the inner code content
			.replace(/```[\s\S]*?```/g, (match) => {
				const lines = match.split('\n');
				return lines.slice(1, -1).join('\n');
			})
			// Remove inline code backticks
			.replace(/`([^`]+)`/g, '$1')
			// Remove bold/italic (***text***, **text**, *text*, ___text___, __text__, _text_)
			.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/\*(.+?)\*/g, '$1')
			.replace(/___(.+?)___/g, '$1')
			.replace(/__(.+?)__/g, '$1')
			.replace(/_(.+?)_/g, '$1')
			// Remove headers (# text)
			.replace(/^#{1,6}\s+/gm, '')
			// Remove blockquotes (> text)
			.replace(/^>\s*/gm, '')
			// Remove horizontal rules
			.replace(/^[-*_]{3,}\s*$/gm, '---')
			// Remove link formatting [text](url) -> text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			// Remove image formatting ![alt](url) -> alt
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
			// Remove strikethrough
			.replace(/~~(.+?)~~/g, '$1')
			// Remove markdown table rows and separators. Runs before any caller
			// collapses whitespace, so line anchoring works on multi-line output.
			// Both are dropped entirely.
			.replace(TABLE_ROW_LINE, '')
			.replace(TABLE_SEPARATOR_LINE, '')
			// Collapse inline pipe-cell runs (3+ pipes) that survive whitespace
			// flattening - covers already-stored summaries where a table was
			// joined onto one line, e.g. "Summary: | Step | Result | |---|---| |".
			// Requires 3+ pipes so prose like "a | b" is left untouched.
			.replace(/(?:[ \t]*\|[^|\n]*){2,}\|/g, ' ')
			// Clean up bullet points - convert to simple dashes
			.replace(/^[\s]*[-*+]\s+/gm, '- ')
			// Clean up numbered lists - keep the numbers
			.replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
	);
};

/**
 * Rewrite markdown table grids as plain text: each row becomes its cells
 * joined with ` · `, and separator rows are dropped. An escaped `\|` is a
 * literal pipe inside a cell, not a boundary, and comes out as `|`. Line
 * structure is kept, so it composes with stripMarkdown() (a table inside a
 * code fence is still unwrapped by it afterwards).
 *
 * For a preview that would otherwise be left with nothing: stripMarkdown()
 * drops tables outright because raw `| col | col |` pipes render as garbage in
 * list views, which is right beside prose and wrong when the table IS the
 * whole answer.
 */
export const flattenMarkdownTables = (text: string): string =>
	text.replace(TABLE_SEPARATOR_LINE, '').replace(TABLE_ROW_LINE, (row) =>
		row
			.split(/(?<!\\)\|/)
			.map((cell) => cell.replace(/\\\|/g, '|').trim())
			.filter(Boolean)
			.join(' · ')
	);
