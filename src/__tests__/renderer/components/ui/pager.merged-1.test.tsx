// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/components/ui/Pager.test.tsx
//   - src/__tests__/renderer/components/ui/TextareaLineNumbers.test.tsx
//   - src/__tests__/renderer/components/ui/GhostIconButton.test.tsx
//   - src/__tests__/renderer/components/ui/TextareaHighlightOverlay.test.tsx
//   - src/__tests__/renderer/components/ui/ToggleSwitch.test.tsx
//   - src/__tests__/renderer/components/ui/HeaderActionButton.test.tsx
//   - src/__tests__/renderer/components/ui/ProviderAvailabilityBar.test.tsx
//   - src/__tests__/renderer/components/ui/ShortcutHint.test.tsx
//   - src/__tests__/renderer/components/ui/HoverTooltip.test.tsx
//   - src/__tests__/renderer/components/ui/EmptyStatePlaceholder.test.tsx
//   - src/__tests__/renderer/components/ui/CountBadge.test.tsx
//   - src/__tests__/renderer/components/ui/CornerDot.test.tsx
//   - src/__tests__/renderer/components/ui/SafeSvgIcon.test.tsx

import { CornerDot } from '../../../../renderer/components/ui/CornerDot';
import { CountBadge } from '../../../../renderer/components/ui/CountBadge';
import { EmptyStatePlaceholder } from '../../../../renderer/components/ui/EmptyStatePlaceholder';
import { GhostIconButton } from '../../../../renderer/components/ui/GhostIconButton';
import { HeaderActionButton } from '../../../../renderer/components/ui/HeaderActionButton';
import { HoverTooltip } from '../../../../renderer/components/ui/HoverTooltip';
import { Pager } from '../../../../renderer/components/ui/Pager';
import { ProviderAvailabilityBar } from '../../../../renderer/components/ui/ProviderAvailabilityBar';
import { SafeSvgIcon } from '../../../../renderer/components/ui/SafeSvgIcon';
import { ShortcutHint, shortcutSuffix } from '../../../../renderer/components/ui/ShortcutHint';
import { TextareaHighlightOverlay } from '../../../../renderer/components/ui/TextareaHighlightOverlay';
import {
	TextareaLineNumbers,
	lineNumberGutterMetrics,
} from '../../../../renderer/components/ui/TextareaLineNumbers';
import { ToggleSwitch, ToggleSwitchTrack } from '../../../../renderer/components/ui/ToggleSwitch';
import type { Theme } from '../../../../renderer/types';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import {
	createMockTheme,
	mockTheme,
	mockTheme as mockTheme_1,
	mockTheme as mockTheme_2,
	mockTheme as mockTheme_3,
	mockTheme as mockTheme_4,
	mockTheme as mockTheme_5,
	mockTheme as mockTheme_6,
	mockTheme as mockTheme_8,
} from '../../../helpers/mockTheme';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import React, { createRef, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => ({
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
}));

// ===== from src/__tests__/renderer/components/ui/Pager.test.tsx =====

const renderPager = (overrides: Partial<React.ComponentProps<typeof Pager>> = {}) => {
	const onPrev = vi.fn();
	const onNext = vi.fn();
	render(
		<Pager
			theme={mockTheme}
			page={2}
			totalPages={5}
			onPrev={onPrev}
			onNext={onNext}
			canGoPrev
			canGoNext
			testId="pager"
			{...overrides}
		/>
	);
	return { onPrev, onNext };
};

describe('Pager', () => {
	it('renders the current page against the total', () => {
		renderPager();
		expect(screen.getByTestId('pager-label')).toHaveTextContent('2 / 5');
	});

	it('announces page changes to assistive tech', () => {
		renderPager();
		// Focus never moves when the page turns, so without a live region a
		// screen reader user gets no signal that the list changed.
		expect(screen.getByTestId('pager-label')).toHaveAttribute('aria-live', 'polite');
	});

	it('reports prev and next clicks', () => {
		const { onPrev, onNext } = renderPager();

		fireEvent.click(screen.getByTestId('pager-next'));
		expect(onNext).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId('pager-prev'));
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it('disables prev on the first page and next on the last', () => {
		const { onPrev } = renderPager({ page: 1, canGoPrev: false });

		const prev = screen.getByTestId('pager-prev');
		expect(prev).toBeDisabled();
		fireEvent.click(prev);
		expect(onPrev).not.toHaveBeenCalled();
	});

	it('disables next at the end', () => {
		const { onNext } = renderPager({ page: 5, canGoNext: false });

		const next = screen.getByTestId('pager-next');
		expect(next).toBeDisabled();
		fireEvent.click(next);
		expect(onNext).not.toHaveBeenCalled();
	});

	it('pages with the arrow keys', () => {
		const { onPrev, onNext } = renderPager();
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'ArrowRight' });
		expect(onNext).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it('ignores arrow keys that would run past an edge', () => {
		const { onPrev } = renderPager({ page: 1, canGoPrev: false });
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onPrev).not.toHaveBeenCalled();
	});

	it('leaves other keys to the host surface', () => {
		const { onPrev, onNext } = renderPager();
		const group = screen.getByRole('group', { name: 'Pagination' });

		fireEvent.keyDown(group, { key: 'Escape' });
		fireEvent.keyDown(group, { key: 'ArrowUp' });

		expect(onPrev).not.toHaveBeenCalled();
		expect(onNext).not.toHaveBeenCalled();
	});

	it('accepts a surface-specific group label', () => {
		renderPager({ ariaLabel: 'Tab pages' });
		expect(screen.getByRole('group', { name: 'Tab pages' })).toBeInTheDocument();
	});
});

// ===== from src/__tests__/renderer/components/ui/TextareaLineNumbers.test.tsx =====

function Harness({
	value,
	fontSize,
	remeasureKey,
}: {
	value: string;
	fontSize?: string;
	remeasureKey?: string | number;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	return (
		<div className="relative">
			<TextareaLineNumbers
				textareaRef={ref}
				value={value}
				theme={createMockTheme()}
				remeasureKey={remeasureKey}
			/>
			<textarea
				ref={ref}
				data-testid="editor"
				value={value}
				readOnly
				style={{
					paddingLeft: lineNumberGutterMetrics(value).textPaddingLeft,
					...(fontSize ? { fontSize } : {}),
				}}
			/>
		</div>
	);
}

describe('lineNumberGutterMetrics', () => {
	it('reserves at least two digits so a short document does not reflow on line 10', () => {
		expect(lineNumberGutterMetrics('one').digits).toBe(2);
		expect(lineNumberGutterMetrics('a\nb\nc').digits).toBe(2);
	});

	it('widens with the line count', () => {
		const hundred = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
		const thousand = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
		expect(lineNumberGutterMetrics(hundred).digits).toBe(3);
		expect(lineNumberGutterMetrics(thousand).digits).toBe(4);
	});

	it('keeps the text padding wider than the gutter so digits never touch the text', () => {
		const metrics = lineNumberGutterMetrics('a\nb');
		expect(metrics.gutterWidth).toBe('calc(2ch + 18px)');
		expect(metrics.textPaddingLeft).toBe('calc(2ch + 24px)');
	});
});

describe('TextareaLineNumbers', () => {
	it('renders one number per logical line', () => {
		render(<Harness value={'first\nsecond\nthird'} />);
		const gutter = screen.getByTestId('line-numbers');
		expect(gutter.textContent).toBe('123');
	});

	it('counts the trailing blank line a newline creates', () => {
		render(<Harness value={'first\n'} />);
		expect(screen.getByTestId('line-numbers').textContent).toBe('12');
	});

	it('hides the gutter from assistive tech - it labels the textarea, it is not content', () => {
		render(<Harness value={'a'} />);
		expect(screen.getByTestId('line-numbers')).toHaveAttribute('aria-hidden', 'true');
	});

	it('translates the numbers by the textarea scroll position', () => {
		render(<Harness value={'a\nb\nc'} />);
		const textarea = screen.getByTestId('editor');
		const rows = screen.getByTestId('line-numbers').firstElementChild as HTMLElement;

		expect(rows.style.transform).toBe('translateY(0px)');

		Object.defineProperty(textarea, 'scrollTop', { value: 42, configurable: true });
		fireEvent.scroll(textarea);

		expect(rows.style.transform).toBe('translateY(-42px)');
	});

	it('pushes the textarea text clear of the gutter', () => {
		render(<Harness value={'a\nb'} />);
		expect(screen.getByTestId('editor')).toHaveStyle({ paddingLeft: 'calc(2ch + 24px)' });
	});

	describe('remeasureKey', () => {
		// The gutter is a sibling rendered BEFORE the textarea, so its layout effect
		// runs while `textareaRef.current` is still null and the mount pass measures
		// nothing. The first real measurement therefore lands on the first re-run,
		// which is what these tests drive with the key.
		it('re-mirrors the textarea typography when the key changes', () => {
			const { rerender } = render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
			rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });

			rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.5} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '21px' });
		});

		it('holds the old typography when the key does not move - the bug the prop exists for', () => {
			// A font-size change leaves the border box the same size, so the
			// component's own ResizeObserver never fires. With nothing in the deps to
			// notice, the gutter keeps the previous font until something else re-runs
			// the measurement.
			const { rerender } = render(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1} />);
			rerender(<Harness value={'a\nb'} fontSize="14px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });

			rerender(<Harness value={'a\nb'} fontSize="21px" remeasureKey={1.1} />);
			expect(screen.getByTestId('line-numbers')).toHaveStyle({ fontSize: '14px' });
		});
	});
});

// ===== from src/__tests__/renderer/components/ui/GhostIconButton.test.tsx =====

describe('GhostIconButton', () => {
	it('renders children and default classes', () => {
		render(
			<GhostIconButton ariaLabel="Close">
				<span data-testid="icon">x</span>
			</GhostIconButton>
		);
		const btn = screen.getByRole('button', { name: 'Close' });
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveClass('rounded');
		expect(btn).toHaveClass('hover:bg-white/10');
		expect(btn).toHaveClass('p-1');
		expect(screen.getByTestId('icon')).toBeInTheDocument();
	});

	it('centers its icon rather than baseline-aligning it', () => {
		render(
			<GhostIconButton ariaLabel="Centered">
				<span>x</span>
			</GhostIconButton>
		);
		// jsdom has no layout engine, so this guards the mechanism rather than the
		// pixels: without these the icon becomes inline content on the line box's
		// baseline, the button's height is driven by the inherited line-height
		// instead of the icon, and the icon rides above the center of its own
		// hover pill.
		const btn = screen.getByRole('button', { name: 'Centered' });
		expect(btn).toHaveClass('inline-flex');
		expect(btn).toHaveClass('items-center');
		expect(btn).toHaveClass('justify-center');
	});

	it('calls onClick when clicked', () => {
		const onClick = vi.fn();
		render(
			<GhostIconButton onClick={onClick} ariaLabel="Do it">
				<span>x</span>
			</GhostIconButton>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('respects disabled prop', () => {
		const onClick = vi.fn();
		render(
			<GhostIconButton onClick={onClick} disabled ariaLabel="Disabled">
				<span>x</span>
			</GhostIconButton>
		);
		const btn = screen.getByRole('button', { name: 'Disabled' });
		expect(btn).toBeDisabled();
		fireEvent.click(btn);
		expect(onClick).not.toHaveBeenCalled();
	});

	it('applies custom padding', () => {
		render(
			<GhostIconButton padding="p-2" ariaLabel="Pad">
				<span>x</span>
			</GhostIconButton>
		);
		expect(screen.getByRole('button', { name: 'Pad' })).toHaveClass('p-2');
	});

	it('announces its state when used as a toggle', () => {
		const { rerender } = render(
			<GhostIconButton pressed ariaLabel="Show tool calls">
				<span>x</span>
			</GhostIconButton>
		);
		expect(screen.getByRole('button', { name: 'Show tool calls' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		rerender(
			<GhostIconButton pressed={false} ariaLabel="Show tool calls">
				<span>x</span>
			</GhostIconButton>
		);
		expect(screen.getByRole('button', { name: 'Show tool calls' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
	});

	it('stays a plain button when `pressed` is omitted', () => {
		// `aria-pressed="false"` on a button that does not toggle is a lie about
		// what it does, so an ordinary action button must carry no attribute.
		render(
			<GhostIconButton ariaLabel="Close">
				<span>x</span>
			</GhostIconButton>
		);
		expect(screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute('aria-pressed');
	});

	it('stops propagation when stopPropagation is true', () => {
		const parentClick = vi.fn();
		const onClick = vi.fn();
		render(
			<div onClick={parentClick}>
				<GhostIconButton onClick={onClick} stopPropagation ariaLabel="Stop">
					<span>x</span>
				</GhostIconButton>
			</div>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(parentClick).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/components/ui/TextareaHighlightOverlay.test.tsx =====

function renderOverlay(value: string, query: string) {
	const ref = createRef<HTMLTextAreaElement>();
	const utils = render(
		<div className="dual-pane-highlight-wrap">
			<TextareaHighlightOverlay
				textareaRef={ref}
				value={value}
				query={query}
				theme={mockTheme_1}
				backgroundColor="#101010"
			/>
			<textarea ref={ref} readOnly value={value} />
		</div>
	);
	const backdrop = utils.container.querySelector('.dual-pane-highlight-backdrop');
	return { ...utils, backdrop, ref };
}

describe('TextareaHighlightOverlay', () => {
	it('renders nothing at all without a query', () => {
		// No marks to paint, so the editor should not carry an invisible copy of
		// its own document.
		const { backdrop } = renderOverlay('some text', '');
		expect(backdrop).toBeNull();
	});

	it('marks every occurrence of the query', () => {
		const { backdrop } = renderOverlay('pedram and pedram again', 'pedram');
		const marks = backdrop!.querySelectorAll('mark');
		expect(marks).toHaveLength(2);
		expect(Array.from(marks, (m) => m.textContent)).toEqual(['pedram', 'pedram']);
	});

	it('matches case-insensitively while preserving the original casing', () => {
		const { backdrop } = renderOverlay('Pedram', 'pedram');
		expect(backdrop!.querySelector('mark')?.textContent).toBe('Pedram');
	});

	it('paints only a background - every glyph it owns is transparent', () => {
		// If the backdrop drew visible text it would double every character,
		// slightly offset, which reads as a rendering fault.
		const { backdrop } = renderOverlay('ask pedram now', 'pedram');
		const mark = backdrop!.querySelector('mark') as HTMLElement;
		expect(mark.style.color).toBe('transparent');
		expect(mark.style.backgroundColor).toBeTruthy();
		for (const span of Array.from(backdrop!.querySelectorAll('span'))) {
			expect((span as HTMLElement).style.color).toBe('transparent');
		}
	});

	it('reproduces the document exactly, so marks line up with the text above', () => {
		const text = 'alpha pedram\nbeta\n\ngamma pedram';
		const { backdrop } = renderOverlay(text, 'pedram');
		// A trailing newline is appended so a document ending in one keeps its
		// last row; everything before it must match the source character for
		// character.
		expect(backdrop!.textContent?.startsWith(text)).toBe(true);
	});

	it('is hidden from assistive tech and from the pointer', () => {
		const { backdrop } = renderOverlay('pedram', 'pedram');
		expect(backdrop!.getAttribute('aria-hidden')).toBe('true');
		// pointer-events comes from the stylesheet, which jsdom does not load, so
		// assert the class that carries it rather than the computed value.
		expect(backdrop!.className).toContain('dual-pane-highlight-backdrop');
	});

	it('carries the editor fill, since the textarea above goes transparent', () => {
		const { backdrop } = renderOverlay('pedram', 'pedram');
		expect((backdrop as HTMLElement).style.backgroundColor).toBeTruthy();
	});

	it('follows the textarea when it scrolls', () => {
		const { backdrop, ref } = renderOverlay('pedram\n'.repeat(50), 'pedram');
		const textarea = ref.current!;

		Object.defineProperty(textarea, 'scrollTop', { value: 120, writable: true });
		textarea.dispatchEvent(new Event('scroll'));

		expect((backdrop as HTMLElement).scrollTop).toBe(120);
	});

	it('survives a query containing regex metacharacters', () => {
		const { backdrop } = renderOverlay('cost $100 today', '$100');
		expect(backdrop!.querySelector('mark')?.textContent).toBe('$100');
	});

	it('renders no marks when the query matches nothing', () => {
		const { backdrop } = renderOverlay('hello world', 'zzz');
		expect(backdrop!.querySelectorAll('mark')).toHaveLength(0);
	});
});

// ===== from src/__tests__/renderer/components/ui/ToggleSwitch.test.tsx =====

/** The pill graphic lives inside the button, so color assertions target it. */
const trackOf = (toggle: HTMLElement): HTMLElement => toggle.firstElementChild as HTMLElement;

describe('ToggleSwitch', () => {
	it('renders as a switch with aria-checked reflecting the state', () => {
		render(<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme_2} />);
		const toggle = screen.getByRole('switch');
		expect(toggle).toHaveAttribute('aria-checked', 'true');
	});

	it('reports the toggled value on click', () => {
		const onChange = vi.fn();
		render(<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme_2} />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('exposes ariaLabel and title', () => {
		render(
			<ToggleSwitch
				checked={false}
				onChange={vi.fn()}
				theme={mockTheme_2}
				ariaLabel="Show commands"
				title="Show in autocomplete"
			/>
		);
		const toggle = screen.getByRole('switch', { name: 'Show commands' });
		expect(toggle).toHaveAttribute('title', 'Show in autocomplete');
	});

	it('does not fire onChange while disabled', () => {
		const onChange = vi.fn();
		render(<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme_2} disabled />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('marks itself busy, shows a spinner, and refuses input while busy', () => {
		const onChange = vi.fn();
		const { container } = render(
			<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme_2} busy />
		);
		const toggle = screen.getByRole('switch');
		expect(toggle).toHaveAttribute('aria-busy', 'true');
		expect(toggle).toBeDisabled();
		expect(container.querySelector('.animate-spin')).toBeTruthy();

		fireEvent.click(toggle);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('omits aria-busy when it is not busy', () => {
		render(<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme_2} />);
		expect(screen.getByRole('switch')).not.toHaveAttribute('aria-busy');
	});

	it('uses the theme accent when checked, or activeColor when one is given', () => {
		const { rerender } = render(
			<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme_2} />
		);
		expect(trackOf(screen.getByRole('switch')).style.backgroundColor).toBe('rgb(189, 147, 249)');

		rerender(
			<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme_2} activeColor="#22c55e" />
		);
		expect(trackOf(screen.getByRole('switch')).style.backgroundColor).toBe('rgb(34, 197, 94)');
	});

	it('renders the compact pill when size is sm', () => {
		const { rerender } = render(
			<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme_2} />
		);
		expect(trackOf(screen.getByRole('switch')).className).toContain('w-10 h-5');

		rerender(<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme_2} size="sm" />);
		expect(trackOf(screen.getByRole('switch')).className).toContain('w-8 h-4');
	});
});

describe('ToggleSwitchTrack', () => {
	it('renders no click target of its own so it can nest inside a host switch', () => {
		const { container } = render(<ToggleSwitchTrack checked={false} theme={mockTheme_2} />);
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('[role="switch"]')).toBeNull();
	});

	it('honors inactiveColor for the unchecked track', () => {
		const { container } = render(
			<ToggleSwitchTrack checked={false} theme={mockTheme_2} inactiveColor="#22c55e" />
		);
		expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe(
			'rgb(34, 197, 94)'
		);
	});
});

// ===== from src/__tests__/renderer/components/ui/HeaderActionButton.test.tsx =====

describe('HeaderActionButton', () => {
	it('renders its label and fires onClick', () => {
		const onClick = vi.fn();
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={onClick}>
				New Memory
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Memory' });
		button.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('sits one step below the header title rather than matching it', () => {
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={vi.fn()}>
				New Session
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Session' });
		expect(button.className).toContain('text-xs');
		expect(button.className).not.toContain('text-sm');
	});

	it('fills with the accent color by default', () => {
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={vi.fn()}>
				Resume
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'Resume' });
		expect(button.style.backgroundColor).toBeTruthy();
	});

	it('renders the ghost variant without an accent fill', () => {
		// A secondary action beside a primary one must not compete with it.
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={vi.fn()} variant="ghost">
				Graph
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'Graph' });
		expect(button.style.backgroundColor).toBe('');
	});

	it('sizes the icon it is given, so callers do not have to', () => {
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={vi.fn()} icon={<svg data-testid="icon" />}>
				New
			</HeaderActionButton>
		);

		const wrapper = screen.getByTestId('icon').parentElement;
		expect(wrapper?.className).toContain('[&>svg]:w-3.5');
	});

	it('does not fire while disabled', () => {
		const onClick = vi.fn();
		render(
			<HeaderActionButton theme={mockTheme_3} onClick={onClick} disabled>
				New Memory
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Memory' });
		button.click();
		expect(onClick).not.toHaveBeenCalled();
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});

// ===== from src/__tests__/renderer/components/ui/ProviderAvailabilityBar.test.tsx =====

function renderBar(props: Partial<React.ComponentProps<typeof ProviderAvailabilityBar>> = {}): {
	onShowAllChange: ReturnType<typeof vi.fn>;
} {
	const onShowAllChange = vi.fn();
	render(
		<ProviderAvailabilityBar
			theme={mockTheme_4}
			availableCount={4}
			totalCount={11}
			locationLabel="locally"
			showAll={false}
			onShowAllChange={onShowAllChange}
			{...props}
		/>
	);
	return { onShowAllChange };
}

describe('ProviderAvailabilityBar', () => {
	it('reads as a sentence in the full variant', () => {
		renderBar();
		expect(screen.getByText('4 providers available locally of 11 supported')).toBeInTheDocument();
		expect(screen.getByText('Show All Supported')).toBeInTheDocument();
	});

	it('drops to bare counts in the compact variant', () => {
		// The full sentence wraps the New Agent modal's section heading onto a
		// second line, which costs a row in a modal that already scrolls.
		renderBar({ variant: 'compact' });
		expect(screen.getByText('4 of 11 locally')).toBeInTheDocument();
		expect(screen.getByText('Show All')).toBeInTheDocument();
	});

	it('names the remote host instead of claiming "locally"', () => {
		// The counts describe whichever machine detection probed.
		renderBar({ locationLabel: 'on build-box' });
		expect(
			screen.getByText('4 providers available on build-box of 11 supported')
		).toBeInTheDocument();
	});

	it('reports the total, not the filtered row count', () => {
		// A count that shrank with the list would read "4 of 4" and answer nothing.
		renderBar({ availableCount: 4, totalCount: 11 });
		expect(screen.queryByText('4 providers available locally of 4 supported')).toBeNull();
	});

	it('toggles and reflects its state', () => {
		const { onShowAllChange } = renderBar();
		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });

		expect(toggle).toHaveAttribute('aria-checked', 'false');
		fireEvent.click(toggle);
		expect(onShowAllChange).toHaveBeenCalledWith(true);
	});

	it('marks itself exempt so a container keyboard handler leaves its keys alone', () => {
		renderBar();
		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });
		expect(toggle.closest('[data-provider-bar-nav-exempt]')).not.toBeNull();
	});
});

// ===== from src/__tests__/renderer/components/ui/ShortcutHint.test.tsx =====

const KEYS = ['Meta', 'Shift', 'r'];

const CHORD = formatShortcutKeys(KEYS);

describe('ShortcutHint', () => {
	it('renders the chord as a right-aligned chip by default', () => {
		const { container } = render(<ShortcutHint theme={mockTheme_5} keys={KEYS} />);
		const chip = container.firstElementChild as HTMLElement;

		expect(chip.tagName).toBe('SPAN');
		expect(chip).toHaveTextContent(CHORD);
		expect(chip.className).toContain('ml-auto');
	});

	it('prefixes the chord with a label when one is supplied', () => {
		render(<ShortcutHint theme={mockTheme_5} keys={KEYS} label="Try:" />);
		expect(screen.getByText(`Try: ${CHORD}`)).toBeInTheDocument();
	});

	// An action can ship unbound. A blank key-cap would advertise a combo that
	// does nothing, so the component renders nothing at all instead.
	it('renders nothing for an unbound action', () => {
		const { container } = render(<ShortcutHint theme={mockTheme_5} keys={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	describe('row variant', () => {
		it('renders a non-interactive header that cannot be reached by keyboard', () => {
			const { container } = render(
				<ShortcutHint theme={mockTheme_5} keys={KEYS} label="Try:" variant="row" />
			);
			const row = container.firstElementChild as HTMLElement;

			expect(row.tagName).toBe('DIV');
			expect(row.closest('button')).toBeNull();
			expect(row).not.toHaveAttribute('tabindex');
			expect(row.className).toContain('select-none');
		});
	});
});

describe('shortcutSuffix', () => {
	it('wraps a bound chord in parentheses with a leading space', () => {
		expect(shortcutSuffix(KEYS)).toBe(` (${CHORD})`);
	});

	// Callers concatenate blindly (`Close tab${shortcutSuffix(keys)}`), so an
	// unbound or missing action must contribute nothing rather than an empty
	// pair of parens.
	it('contributes nothing when the action is unbound', () => {
		expect(shortcutSuffix([])).toBe('');
		expect(shortcutSuffix(undefined)).toBe('');
	});
});

// ===== from src/__tests__/renderer/components/ui/HoverTooltip.test.tsx =====

function open(ui: React.ReactElement) {
	render(ui);
	fireEvent.mouseEnter(screen.getByText('trigger').parentElement!);
	return screen.getByRole('tooltip');
}

describe('HoverTooltip', () => {
	it('keeps a short label on one line by default', () => {
		const tip = open(
			<HoverTooltip theme={mockTheme_6} label="Short">
				<span>trigger</span>
			</HoverTooltip>
		);

		expect(tip.className).toContain('whitespace-nowrap');
		expect(tip.style.maxWidth).toBe('');
	});

	// A sentence-length label in nowrap mode becomes a ribbon as wide as the text,
	// which the viewport clamp can only slide around, not shrink.
	it('wraps and caps its width when given a maxWidth', () => {
		const tip = open(
			<HoverTooltip
				theme={mockTheme_6}
				maxWidth={260}
				label="Mark that you checked this entry yourself. Entirely optional, and only a bookmark for your own review pass."
			>
				<span>trigger</span>
			</HoverTooltip>
		);

		expect(tip.className).not.toContain('whitespace-nowrap');
		expect(tip.style.maxWidth).toBe('260px');
	});

	it('never lets the cap exceed the window, so the clamp has room to work', () => {
		const original = window.innerWidth;
		Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
		try {
			const tip = open(
				<HoverTooltip theme={mockTheme_6} maxWidth={600} label="A long explanatory sentence.">
					<span>trigger</span>
				</HoverTooltip>
			);
			// 200 minus the 8px viewport margin on each side.
			expect(tip.style.maxWidth).toBe('184px');
		} finally {
			Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
		}
	});
});

// ===== from src/__tests__/renderer/components/ui/EmptyStatePlaceholder.test.tsx =====

const mockTheme_7: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

describe('EmptyStatePlaceholder', () => {
	it('renders title only', () => {
		render(<EmptyStatePlaceholder theme={mockTheme_7} title="No items" />);
		expect(screen.getByText('No items')).toBeInTheDocument();
	});

	it('renders icon when provided', () => {
		render(
			<EmptyStatePlaceholder
				theme={mockTheme_7}
				title="No items"
				icon={<svg data-testid="icon" />}
			/>
		);
		expect(screen.getByTestId('icon')).toBeInTheDocument();
	});

	it('renders description when provided', () => {
		render(
			<EmptyStatePlaceholder
				theme={mockTheme_7}
				title="Empty"
				description="Try adjusting your filters"
			/>
		);
		expect(screen.getByText('Try adjusting your filters')).toBeInTheDocument();
	});

	it('renders action when provided', () => {
		render(
			<EmptyStatePlaceholder theme={mockTheme_7} title="Empty" action={<button>Clear</button>} />
		);
		expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
	});
});

// ===== from src/__tests__/renderer/components/ui/CountBadge.test.tsx =====

function renderBadge(props: Partial<React.ComponentProps<typeof CountBadge>> = {}) {
	const { container } = render(
		<CountBadge count={3} theme={mockTheme_8} label="panel" {...props} />
	);
	return container.firstElementChild as HTMLElement;
}

describe('CountBadge', () => {
	it('renders the count', () => {
		expect(renderBadge().textContent).toBe('3');
	});

	it('renders a zero rather than hiding itself - showing it is the caller call', () => {
		expect(renderBadge({ count: 0 }).textContent).toBe('0');
	});

	it('announces the count with its noun so a screen reader hears more than a digit', () => {
		const badge = renderBadge();
		expect(badge.getAttribute('aria-label')).toBe('3 panels');
		expect(badge.getAttribute('title')).toBe('3 panels');
	});

	it('uses the singular at one', () => {
		expect(renderBadge({ count: 1 }).getAttribute('aria-label')).toBe('1 panel');
	});

	it('caps the display at max but still announces the true count', () => {
		const badge = renderBadge({ count: 250, max: 99 });
		expect(badge.textContent).toBe('99+');
		expect(badge.getAttribute('aria-label')).toBe('250 panels');
	});

	it('does not cap at exactly max', () => {
		expect(renderBadge({ count: 99, max: 99 }).textContent).toBe('99');
	});

	it('uses tabular numerals so the pill does not jitter as the count changes', () => {
		expect(renderBadge().className).toContain('tabular-nums');
	});

	it('takes the theme accent, and lets a caller override style', () => {
		const badge = renderBadge({ style: { opacity: '0.5' } });
		expect(badge.style.color).toBeTruthy();
		expect(badge.style.opacity).toBe('0.5');
	});

	it('passes through className and data-testid', () => {
		const badge = renderBadge({ className: 'ml-1', 'data-testid': 'panel-count' });
		expect(badge.className).toContain('ml-1');
		expect(badge.getAttribute('data-testid')).toBe('panel-count');
	});
});

// ===== from src/__tests__/renderer/components/ui/CornerDot.test.tsx =====

function renderDot(props: Partial<React.ComponentProps<typeof CornerDot>> = {}) {
	const { container } = render(<CornerDot color="#ff0000" {...props} />);
	return container.firstElementChild as HTMLElement;
}

describe('CornerDot', () => {
	it('defaults to a small steady dot in the top-right corner', () => {
		const dot = renderDot();
		expect(dot.className).toContain('w-1.5');
		expect(dot.className).toContain('-top-0.5');
		expect(dot.className).toContain('-right-0.5');
		expect(dot.className).not.toContain('animate-pulse');
		expect(dot).toHaveStyle({ backgroundColor: '#ff0000' });
	});

	it('pulses and grows on request', () => {
		const dot = renderDot({ pulse: true, size: 'md' });
		expect(dot.className).toContain('animate-pulse');
		expect(dot.className).toContain('w-2');
	});

	it('hangs off the right edge when placement is right', () => {
		const dot = renderDot({ placement: 'right' });
		expect(dot.className).toContain('top-1/2');
		expect(dot.className).not.toContain('-top-0.5');
	});

	it('rings the dot so it reads on top of a filled parent', () => {
		expect(renderDot({ ringColor: '#123456' })).toHaveStyle({
			boxShadow: '0 0 0 1.5px #123456',
		});
	});

	// The dot repeats what its parent already says, so it stays out of the
	// a11y tree unless a title gives it something of its own to announce.
	it('is aria-hidden without a title and announced with one', () => {
		expect(renderDot().getAttribute('aria-hidden')).toBe('true');
		const titled = renderDot({ title: 'Unread messages' });
		expect(titled.getAttribute('aria-hidden')).toBeNull();
		expect(titled.getAttribute('title')).toBe('Unread messages');
	});

	// pointer-events-none would suppress the native title tooltip entirely.
	it('does not disable pointer events', () => {
		expect(renderDot({ title: 'Unread messages' }).className).not.toContain('pointer-events-none');
	});
});

// ===== from src/__tests__/renderer/components/ui/SafeSvgIcon.test.tsx =====

describe('SafeSvgIcon', () => {
	it('renders host-owned SVG markup containing only the contributed path data', () => {
		render(<SafeSvgIcon data-testid="safe-svg-icon" path="M3 12H21" viewBox="0 0 24 24" />);

		const svg = screen.getByTestId('safe-svg-icon');
		expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
		expect(svg).toHaveAttribute('fill', 'none');
		expect(svg).toHaveAttribute('stroke', 'currentColor');
		expect(svg.querySelectorAll('path')).toHaveLength(1);
		expect(svg.querySelector('path')).toHaveAttribute('d', 'M3 12H21');
		expect(svg.querySelector('script, foreignObject, image, use')).toBeNull();
	});
});
