import { memo, useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Layers } from 'lucide-react';
import type { Theme } from '../../../types';
import type { TabProviderChoice } from '../hooks/useTabProviderChoice';
import { useAnchoredMenuPosition } from '../../../hooks/ui/useAnchoredMenuPosition';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { useListNavigation } from '../../../hooks/keyboard/useListNavigation';
import { useFocusOnMount } from '../../../hooks/utils/useFocusAfterRender';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { EscCloseButton } from '../../ui/EscCloseButton';

export const ProviderPill = memo(function ProviderPill({
	theme,
	choice,
	onOpen,
}: {
	theme: Theme;
	choice: TabProviderChoice;
	onOpen: () => void;
}) {
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => {
		setOpen(false);
		anchor.current?.focus();
	}, []);
	return (
		<>
			<button
				ref={anchor}
				type="button"
				disabled={!!choice.problem}
				aria-label={`Provider for this tab: ${choice.label}`}
				aria-haspopup="menu"
				aria-expanded={open}
				title={choice.problem ?? 'Change provider for this tab'}
				className="flex items-center gap-1 text-2xs px-2 py-1 rounded-full transition-all opacity-60 hover:opacity-100 disabled:cursor-not-allowed"
				style={{
					backgroundColor: `${theme.colors.accent}10`,
					color: theme.colors.accent,
					border: `1px solid ${theme.colors.accent}25`,
				}}
				onClick={() => {
					onOpen();
					setOpen(!open);
				}}
				onKeyDown={(e) => {
					if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						setOpen(true);
					}
				}}
			>
				<Layers className="w-3 h-3" />
				<span>{choice.label}</span>
				<ChevronDown className="w-3 h-3" />
			</button>
			{open && !choice.problem && (
				<ProviderMenu theme={theme} choice={choice} anchor={anchor} onClose={close} />
			)}
		</>
	);
});

function ProviderMenu({
	theme,
	choice,
	anchor,
	onClose,
}: {
	theme: Theme;
	choice: TabProviderChoice;
	anchor: RefObject<HTMLButtonElement>;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const id = useId();
	const { left, top, maxHeight, ready } = useAnchoredMenuPosition(ref, anchor, {
		placement: 'above',
		contentKey: choice.options.map((option) => `${option.provider}:${option.problem}`).join('|'),
	});
	useClickOutside([ref, anchor] as RefObject<HTMLElement>[], onClose);
	useModalLayer(MODAL_PRIORITIES.PROVIDER_PILL_MENU, 'Tab provider', onClose, {
		focusTrap: 'none',
	});
	useFocusOnMount(ref, 0);
	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: choice.options.length,
		wrap: true,
		enablePageNavigation: true,
		initialIndex: Math.max(
			0,
			choice.options.findIndex((option) => option.provider === choice.current)
		),
		onSelect: (index) => {
			const option = choice.options[index];
			if (!option.problem)
				void choice.select(option.provider).then((ok) => {
					if (ok) onClose();
				});
		},
	});
	const optionKeys = choice.options.map((option) => option.provider ?? 'inherit').join('|');
	const currentIndex = choice.options.findIndex((option) => option.provider === choice.current);
	useEffect(() => {
		// Detection and the installed-only toggle can move the same provider to a new row.
		setSelectedIndex(Math.max(0, currentIndex));
	}, [optionKeys, currentIndex, setSelectedIndex]);
	useEffect(() => {
		const row = document.getElementById(`${id}-${selectedIndex}`);
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: 'nearest' });
	}, [id, selectedIndex]);
	return createPortal(
		<div
			ref={ref}
			role="menu"
			aria-label="Provider for this tab"
			tabIndex={-1}
			aria-activedescendant={`${id}-${selectedIndex}`}
			onKeyDown={(e) => {
				e.stopPropagation();
				const button = (e.target as HTMLElement).closest('button');
				if (button && e.key === 'Enter') {
					e.preventDefault();
					button.click();
					return;
				}
				handleKeyDown(e);
			}}
			className="fixed z-[100] rounded border shadow-lg overflow-y-auto w-80 max-w-[calc(100vw-16px)] p-1"
			style={{
				left,
				top,
				maxHeight,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			<div
				className="flex items-center justify-between px-2 py-1 text-xs"
				style={{ color: theme.colors.textDim }}
			>
				Provider for this tab
				<EscCloseButton theme={theme} onClose={onClose} />
			</div>
			{choice.options.map((option, index) => (
				<button
					key={option.provider ?? 'inherit'}
					id={`${id}-${index}`}
					type="button"
					role="menuitemradio"
					aria-checked={option.selected}
					aria-disabled={!!option.problem}
					tabIndex={-1}
					title={option.problem ?? option.description}
					onFocus={() => setSelectedIndex(index)}
					onMouseEnter={() => setSelectedIndex(index)}
					onClick={() => {
						if (!option.problem)
							void choice.select(option.provider).then((ok) => {
								if (ok) onClose();
							});
					}}
					className="w-full flex items-center gap-2 text-left rounded px-3 py-2 text-xs"
					style={{
						color: option.problem ? theme.colors.textDim : theme.colors.textMain,
						backgroundColor: selectedIndex === index ? `${theme.colors.accent}18` : undefined,
					}}
				>
					<span className="flex-1">
						<span className="block">{option.label}</span>
						{(option.problem ?? option.description) && (
							<span className="block text-2xs" style={{ color: theme.colors.textDim }}>
								{option.problem ?? option.description}
							</span>
						)}
					</span>
					{option.selected && <Check className="w-3 h-3 shrink-0" />}
				</button>
			))}
			<button
				type="button"
				role="menuitemcheckbox"
				aria-checked={choice.showAll}
				className="w-full text-left px-3 py-2 text-xs"
				style={{ color: theme.colors.accent }}
				onClick={() => choice.setShowAll(!choice.showAll)}
			>
				{choice.showAll ? 'Show installed providers' : 'Show all providers'}
			</button>
			{choice.error && (
				<p role="alert" className="px-3 py-2 text-xs" style={{ color: theme.colors.error }}>
					{choice.error}
				</p>
			)}
		</div>,
		document.body
	);
}
