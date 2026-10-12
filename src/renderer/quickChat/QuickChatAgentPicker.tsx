/**
 * QuickChatAgentPicker - choose the agent a Quick Chat talks to.
 *
 * Replaces a native <select>. A native popup menu is unreliable inside the
 * Quick Chat window (a transparent, non-activating macOS panel), offers no
 * filter, and is unusable past a few dozen agents. This is the HeadingPalette
 * shape instead: a fuzzy filter over the list, arrow keys to move, Enter to
 * pick, Escape to back out without picking.
 *
 * It renders INSIDE the window, just below the header that holds its trigger,
 * because the window is an OS window and nothing can be drawn outside it;
 * QuickChatRoot grows the window while the picker is open so a composer-only
 * window has room for it.
 *
 * With no query the list keeps the order the engine sends (the Left Bar's
 * order) so it reads as the agents the user already knows. With a query it
 * sorts best match first, because a picker is used to land on ONE row.
 */

import { useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { QuickChatAgentOption } from '../../shared/quickChat';
import { fuzzyMatchWithIndices, fuzzyMatchWithScore, renderFuzzyHighlight } from '../utils/search';
import { useListNavigation } from '../hooks/keyboard/useListNavigation';
import { useScrollIntoView } from '../hooks/ui/useScrollIntoView';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { EscCloseButton } from '../components/ui/EscCloseButton';
import type { Theme } from '../types';

interface QuickChatAgentPickerProps {
	theme: Theme;
	agents: QuickChatAgentOption[];
	/** The agent the chat is on now, highlighted and selected first. */
	currentAgentId: string | null;
	onPick: (agentId: string) => void;
	/** Close without picking. */
	onClose: () => void;
}

interface FilteredAgent {
	agent: QuickChatAgentOption;
	nameIndices: Set<number>;
	score: number;
}

/**
 * Match one agent against the query. The name is what gets highlighted; the
 * group and provider also count, so "codex" or a group name narrows the list
 * even when no agent is named after it. A name hit outranks a group or
 * provider hit.
 */
export function matchQuickChatAgent(
	agent: QuickChatAgentOption,
	query: string
): FilteredAgent | null {
	if (!query) return { agent, nameIndices: new Set(), score: 0 };
	const byName = fuzzyMatchWithScore(agent.name, query);
	if (byName.matches) {
		return {
			agent,
			nameIndices: new Set(fuzzyMatchWithIndices(agent.name, query)),
			score: byName.score + 1000,
		};
	}
	for (const extra of [agent.groupName, agent.provider]) {
		if (!extra) continue;
		const hit = fuzzyMatchWithScore(extra, query);
		if (hit.matches) return { agent, nameIndices: new Set(), score: hit.score };
	}
	return null;
}

/** Filter and order the agents for a query (see the file header for the order rule). */
export function filterQuickChatAgents(
	agents: QuickChatAgentOption[],
	query: string
): FilteredAgent[] {
	const hits = agents
		.map((agent) => matchQuickChatAgent(agent, query))
		.filter((hit): hit is FilteredAgent => hit !== null);
	if (query) hits.sort((a, b) => b.score - a.score);
	return hits;
}

export function QuickChatAgentPicker({
	theme,
	agents,
	currentAgentId,
	onPick,
	onClose,
}: QuickChatAgentPickerProps) {
	const [query, setQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);
	const c = theme.colors;

	useFocusOnMount(inputRef, 0);

	const filtered = useMemo(() => filterQuickChatAgents(agents, query), [agents, query]);

	const pick = (index: number) => {
		const hit = filtered[index];
		if (hit) onPick(hit.agent.id);
	};

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: filtered.length,
		onSelect: pick,
		initialIndex: Math.max(
			0,
			agents.findIndex((a) => a.id === currentAgentId)
		),
		enablePageNavigation: true,
		wrap: true,
	});

	const itemRefs = useScrollIntoView<HTMLButtonElement>(
		true,
		selectedIndex,
		filtered.length,
		'auto'
	);

	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// Every plain key typed here is the picker's. Escape especially: the
		// window's own Escape hides Quick Chat, and backing out of a picker must
		// not. Cmd/Ctrl chords (Cmd+K to close, Cmd+B, Cmd+P) still reach the
		// window, which ignores any chord it does not own.
		if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			pick(selectedIndex);
			return;
		}
		// Home/End belong to the text field while there is text to move through.
		if ((e.key === 'Home' || e.key === 'End') && query) return;
		handleKeyDown(e);
	};

	return (
		<div
			className="flex-1 min-h-0 mx-3 mb-2 rounded-2xl flex flex-col overflow-hidden"
			style={{ backgroundColor: c.bgSidebar, border: `1px solid ${c.border}` }}
			data-testid="quick-chat-agent-picker"
		>
			<div
				className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0"
				style={{ borderColor: c.border }}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setSelectedIndex(0);
					}}
					onKeyDown={onInputKeyDown}
					placeholder="Switch agent..."
					aria-label="Filter agents"
					spellCheck={false}
					className="flex-1 bg-transparent border-none outline-none text-sm"
					style={{ color: c.textMain }}
					data-testid="quick-chat-agent-filter"
				/>
				<span className="text-xs shrink-0" style={{ color: c.textDim }}>
					{filtered.length} of {agents.length}
				</span>
				<EscCloseButton onClose={onClose} theme={theme} />
			</div>
			<div
				className="overflow-y-auto flex-1 min-h-0 py-1"
				style={{ overscrollBehavior: 'contain' }}
				role="listbox"
				aria-label="Agents"
			>
				{filtered.length === 0 ? (
					<div className="px-3 py-6 text-center text-sm" style={{ color: c.textDim }}>
						{agents.length === 0 ? 'No agents to chat with' : `No agent matches "${query}"`}
					</div>
				) : (
					filtered.map(({ agent, nameIndices }, index) => {
						const isSelected = index === selectedIndex;
						const isCurrent = agent.id === currentAgentId;
						const detail = [agent.groupName, agent.provider].filter(Boolean).join(' - ');
						return (
							<button
								key={agent.id}
								ref={(el) => {
									itemRefs.current[index] = el;
								}}
								type="button"
								role="option"
								aria-selected={isSelected}
								data-testid="quick-chat-agent-row"
								onMouseMove={() => setSelectedIndex(index)}
								onClick={() => pick(index)}
								className="w-full px-3 py-1.5 text-left flex items-center gap-2 focus:outline-none"
								style={{
									backgroundColor: isSelected ? `${c.accent}25` : undefined,
									boxShadow: isSelected ? `inset 2px 0 0 ${c.accent}` : undefined,
								}}
								title={detail ? `${agent.name} (${detail})` : agent.name}
							>
								<span className="w-4 shrink-0 flex justify-center">
									{isCurrent && <Check className="w-3.5 h-3.5" style={{ color: c.accent }} />}
								</span>
								<span className="truncate text-sm" style={{ color: c.textMain }}>
									{renderFuzzyHighlight(agent.name, nameIndices, {
										match: { fontWeight: 700, color: c.accent },
										rest: {},
									})}
								</span>
								{detail && (
									<span
										className="ml-auto pl-3 shrink-0 text-xs truncate"
										style={{ color: c.textDim }}
									>
										{detail}
									</span>
								)}
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
