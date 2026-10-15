// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/components/ui/EmojiPickerField.test.tsx
//   - src/__tests__/renderer/components/ui/Modal.test.tsx
//   - src/__tests__/renderer/components/ui/RecordDetailModal.test.tsx

import {
	EmojiPickerField,
	GroupAppearancePicker,
} from '../../../../renderer/components/ui/EmojiPickerField';
import { Modal, ModalFooter } from '../../../../renderer/components/ui/Modal';
import { RecordDetailModal } from '../../../../renderer/components/ui/RecordDetailModal';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Theme } from '../../../../renderer/types';
import type { IconPackContribution } from '../../../../shared/plugins/contributions';
import { mockTheme as mockTheme_1, mockTheme as mockTheme_2 } from '../../../helpers/mockTheme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@emoji-mart/data', () => ({
	default: {},
}));
vi.mock('@emoji-mart/react', () => ({
	default: ({
		onEmojiSelect,
		autoFocus,
	}: {
		onEmojiSelect: (emoji: { native: string }) => void;
		autoFocus?: boolean;
	}) => (
		<div data-testid="emoji-picker-mock">
			<button
				onClick={() => onEmojiSelect({ native: '🎉' })}
				data-testid="emoji-option"
				autoFocus={autoFocus}
			>
				Select party emoji
			</button>
		</div>
	),
}));

// ===== from src/__tests__/renderer/components/ui/EmojiPickerField.test.tsx =====

// Mock theme for testing
const mockTheme: Theme = {
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

describe('EmojiPickerField', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('should render emoji button with current value', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toBeInTheDocument();
			expect(button).toHaveTextContent('📂');
		});

		it('should render with default label "Icon"', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			expect(screen.getByText('Icon')).toBeInTheDocument();
		});

		it('should render with custom label when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} label="Group Icon" />
			);

			expect(screen.getByText('Group Icon')).toBeInTheDocument();
		});

		it('should apply data-testid when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			expect(screen.getByTestId('emoji-field')).toBeInTheDocument();
			expect(screen.getByTestId('emoji-field-button')).toBeInTheDocument();
		});

		it('should not show picker overlay initially', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('disabled state', () => {
		it('should disable button when disabled prop is true', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} disabled />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toBeDisabled();
		});

		it('should not open picker when disabled', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					disabled
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			fireEvent.click(button);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should apply opacity styling when disabled', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} disabled />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveStyle({ opacity: '0.5' });
		});
	});

	describe('picker interactions', () => {
		it('should open picker overlay when button is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);

			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();
			expect(screen.getByTestId('emoji-picker-mock')).toBeInTheDocument();
		});

		it('should call onOpen when picker opens', () => {
			const onChange = vi.fn();
			const onOpen = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onOpen={onOpen}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);

			expect(onOpen).toHaveBeenCalledTimes(1);
		});

		it('should close picker when backdrop is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Click backdrop (the overlay itself)
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should close picker when close button is clicked', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Click close button
			const closeButton = screen.getByTestId('emoji-field-close');
			fireEvent.click(closeButton);

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should close picker when Escape key is pressed', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			const button = screen.getByTestId('emoji-field-button');
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should call onClose when picker closes via backdrop', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when picker closes via close button', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via close button
			fireEvent.click(screen.getByTestId('emoji-field-close'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when picker closes via Escape', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('emoji selection', () => {
		it('should call onChange with selected emoji', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji (from mock)
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(onChange).toHaveBeenCalledWith('🎉');
		});

		it('should close picker after emoji selection', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});

		it('should call onClose after emoji selection', () => {
			const onChange = vi.fn();
			const onClose = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					onClose={onClose}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus restoration', () => {
		it('should restore focus to restoreFocusRef after closing via backdrop', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			// Run timers to allow focus restoration
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should restore focus to restoreFocusRef after emoji selection', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Select emoji
			fireEvent.click(screen.getByTestId('emoji-option'));

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should restore focus to restoreFocusRef after Escape', async () => {
			const onChange = vi.fn();
			const inputRef = React.createRef<HTMLInputElement>();

			render(
				<div>
					<input ref={inputRef} data-testid="target-input" />
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						restoreFocusRef={inputRef}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.getByTestId('target-input')).toHaveFocus();
		});

		it('should handle missing restoreFocusRef gracefully', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Close via backdrop (should not throw)
			fireEvent.click(screen.getByTestId('emoji-field-overlay'));

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			// Should complete without error
			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('should have correct aria attributes on button', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveAttribute('aria-haspopup', 'dialog');
			expect(button).toHaveAttribute('aria-expanded', 'false');
		});

		it('should update aria-expanded when picker opens', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveAttribute('aria-expanded', 'false');

			fireEvent.click(button);
			expect(button).toHaveAttribute('aria-expanded', 'true');
		});

		it('should have dialog role on overlay', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			const overlay = screen.getByRole('dialog');
			expect(overlay).toBeInTheDocument();
			expect(overlay).toHaveAttribute('aria-modal', 'true');
			expect(overlay).toHaveAttribute('aria-label', 'Emoji picker');
		});

		it('should have accessible close button', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			const closeButton = screen.getByRole('button', { name: /close emoji picker/i });
			expect(closeButton).toBeInTheDocument();
		});
	});

	describe('theming', () => {
		it('should apply theme border color to button', () => {
			const onChange = vi.fn();

			render(<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} />);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveStyle({ borderColor: '#333333' });
		});

		it('should apply theme colors to label', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField theme={mockTheme} value="📂" onChange={onChange} label="Test Label" />
			);

			const label = screen.getByText('Test Label');
			expect(label).toHaveStyle({ color: '#ffffff' });
		});
	});

	describe('toggle behavior', () => {
		it('should toggle picker closed when button clicked while open', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			const button = screen.getByTestId('emoji-field-button');

			// Open
			fireEvent.click(button);
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();

			// Toggle closed
			fireEvent.click(button);
			expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument();
		});
	});

	describe('event propagation', () => {
		it('should stop propagation on picker container click', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					data-testid="emoji-field"
				/>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Click on picker container (not backdrop) should not close
			fireEvent.click(screen.getByTestId('emoji-picker-mock'));

			// Should still be open
			expect(screen.getByTestId('emoji-field-overlay')).toBeInTheDocument();
		});

		it('should stop escape propagation to prevent parent handlers', () => {
			const onChange = vi.fn();
			const parentEscapeHandler = vi.fn();

			render(
				<div onKeyDown={(e) => e.key === 'Escape' && parentEscapeHandler()}>
					<EmojiPickerField
						theme={mockTheme}
						value="📂"
						onChange={onChange}
						data-testid="emoji-field"
					/>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByTestId('emoji-field-button'));

			// Press Escape on overlay
			fireEvent.keyDown(screen.getByTestId('emoji-field-overlay'), { key: 'Escape' });

			// Parent should not receive event
			expect(parentEscapeHandler).not.toHaveBeenCalled();
		});
	});

	describe('custom button className', () => {
		it('should apply custom buttonClassName when provided', () => {
			const onChange = vi.fn();

			render(
				<EmojiPickerField
					theme={mockTheme}
					value="📂"
					onChange={onChange}
					buttonClassName="custom-emoji-button"
				/>
			);

			const button = screen.getByRole('button', { name: /select emoji/i });
			expect(button).toHaveClass('custom-emoji-button');
		});
	});
});

describe('GroupAppearancePicker', () => {
	it('clears the emoji when an icon is selected', () => {
		const onEmojiChange = vi.fn();
		const onIconChange = vi.fn();

		render(
			<GroupAppearancePicker
				theme={mockTheme}
				emoji="📂"
				icon={undefined}
				color={undefined}
				onEmojiChange={onEmojiChange}
				onIconChange={onIconChange}
				onColorChange={vi.fn()}
				groupsPlusEnabled
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Use Folder icon' }));

		expect(onIconChange).toHaveBeenCalledWith('folder');
		expect(onEmojiChange).toHaveBeenCalledWith('');
	});

	it('keeps emoji selection available when Groups+ is off but hides icon and color controls', () => {
		render(
			<GroupAppearancePicker
				theme={mockTheme}
				emoji="📂"
				icon="folder"
				color="#22C55E"
				onEmojiChange={vi.fn()}
				onIconChange={vi.fn()}
				onColorChange={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: /select emoji/i })).toBeInTheDocument();
		expect(screen.queryByText('Standard icon')).not.toBeInTheDocument();
		expect(screen.queryByText('Label color')).not.toBeInTheDocument();
		expect(screen.queryByText('Acme Bright')).not.toBeInTheDocument();
	});

	it('renders contributed icon and color sections after built-ins', () => {
		const onEmojiChange = vi.fn();
		const onIconChange = vi.fn();
		const onColorChange = vi.fn();
		const iconPacks: IconPackContribution[] = [
			{
				id: 'com.acme/bright',
				localId: 'bright',
				pluginId: 'com.acme',
				label: 'Acme Bright',
				icons: [
					{
						id: 'com.acme/bright/bolt',
						localId: 'bolt',
						label: 'Bolt',
						path: 'M13 2L3 14H12L11 22L21 10H12L13 2',
					},
				],
				colors: [
					{
						id: 'com.acme/bright/lime',
						localId: 'lime',
						label: 'Lime',
						value: '#22C55E',
					},
				],
			},
		];
		render(
			<GroupAppearancePicker
				theme={mockTheme}
				emoji="📂"
				icon={undefined}
				color={undefined}
				iconPacks={iconPacks}
				onEmojiChange={onEmojiChange}
				onIconChange={onIconChange}
				onColorChange={onColorChange}
				groupsPlusEnabled
			/>
		);

		const standardIcons = screen.getByText('Standard icon');
		const packLabel = screen.getByText('Acme Bright');
		expect(
			standardIcons.compareDocumentPosition(packLabel) & Node.DOCUMENT_POSITION_FOLLOWING
		).not.toBe(0);

		fireEvent.click(screen.getByRole('button', { name: 'Use Bolt icon' }));
		fireEvent.click(screen.getByRole('button', { name: 'Use Lime label color' }));

		expect(onIconChange).toHaveBeenCalledWith('com.acme/bright/bolt');
		expect(onEmojiChange).toHaveBeenCalledWith('');
		expect(onColorChange).toHaveBeenCalledWith('com.acme/bright/lime');
	});

	it('clears the icon when an emoji is selected', () => {
		const onEmojiChange = vi.fn();
		const onIconChange = vi.fn();

		render(
			<GroupAppearancePicker
				theme={mockTheme}
				emoji=""
				icon="folder"
				color={undefined}
				onEmojiChange={onEmojiChange}
				onIconChange={onIconChange}
				onColorChange={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /select emoji/i }));
		fireEvent.click(screen.getByTestId('emoji-option'));

		expect(onEmojiChange).toHaveBeenCalledWith('🎉');
		expect(onIconChange).toHaveBeenCalledWith(undefined);
	});

	describe('label color selection', () => {
		it('marks no color as selected when the stored color is unset', () => {
			render(
				<GroupAppearancePicker
					theme={mockTheme}
					emoji="📂"
					onEmojiChange={vi.fn()}
					onIconChange={vi.fn()}
					onColorChange={vi.fn()}
					groupsPlusEnabled
				/>
			);

			expect(screen.getByRole('button', { name: 'Clear label color' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('does not mark no color as selected for a built-in color', () => {
			render(
				<GroupAppearancePicker
					theme={mockTheme}
					emoji="📂"
					color="#22C55E"
					onEmojiChange={vi.fn()}
					onIconChange={vi.fn()}
					onColorChange={vi.fn()}
					groupsPlusEnabled
				/>
			);

			expect(screen.getByRole('button', { name: 'Clear label color' })).toHaveAttribute(
				'aria-pressed',
				'false'
			);
		});

		it('does not mark no color as selected for a resolvable plugin color', () => {
			render(
				<GroupAppearancePicker
					theme={mockTheme}
					emoji="📂"
					color="com.acme/bright/lime"
					iconPacks={[
						{
							id: 'com.acme/bright',
							localId: 'bright',
							pluginId: 'com.acme',
							label: 'Acme Bright',
							icons: [],
							colors: [
								{
									id: 'com.acme/bright/lime',
									localId: 'lime',
									label: 'Lime',
									value: '#22C55E',
								},
							],
						},
					]}
					onEmojiChange={vi.fn()}
					onIconChange={vi.fn()}
					onColorChange={vi.fn()}
					groupsPlusEnabled
				/>
			);

			expect(screen.getByRole('button', { name: 'Clear label color' })).toHaveAttribute(
				'aria-pressed',
				'false'
			);
		});

		it('preserves an unavailable plugin color until the user explicitly clears it', () => {
			const onColorChange = vi.fn();

			render(
				<GroupAppearancePicker
					theme={mockTheme}
					emoji="📂"
					color="com.acme/bright/lime"
					onEmojiChange={vi.fn()}
					onIconChange={vi.fn()}
					onColorChange={onColorChange}
					groupsPlusEnabled
				/>
			);

			const clearButton = screen.getByRole('button', { name: 'Clear label color' });
			expect(clearButton).toHaveAttribute('aria-pressed', 'false');
			expect(screen.getByLabelText('Stored label color unavailable')).toBeInTheDocument();

			fireEvent.click(clearButton);

			expect(onColorChange).toHaveBeenCalledWith(undefined);
		});
	});
});

// ===== from src/__tests__/renderer/components/ui/Modal.test.tsx =====

/** RTL `wrapper` form of the LayerStackProvider the other helpers nest inline. */
const LayerStackWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

function renderModal(overrides: Partial<React.ComponentProps<typeof Modal>> = {}) {
	const onClose = overrides.onClose ?? vi.fn();

	render(
		<LayerStackProvider>
			<Modal
				theme={mockTheme_1}
				title="Shared Modal"
				priority={123}
				onClose={onClose}
				resizeKey="shared-modal-test"
				testId="shared-modal-overlay"
				{...overrides}
			>
				<div>Modal body</div>
			</Modal>
		</LayerStackProvider>
	);

	return { onClose };
}

describe('Modal', () => {
	beforeEach(() => {
		useSettingsStore.setState({ modalSizes: {} });
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	it('renders resize handles when resizable with a stable key', () => {
		renderModal();

		expect(screen.getByTestId('modal-resize-handle-se')).toBeInTheDocument();
		expect(
			document.querySelector('[data-modal-resize-key="shared-modal-test"]')
		).toBeInTheDocument();
	});

	it('does not enable resizing without an explicit resizeKey', () => {
		renderModal({ resizeKey: undefined, width: 450, maxHeight: '70vh' });

		expect(screen.queryByTestId('modal-resize-handle-se')).not.toBeInTheDocument();
		expect(document.querySelector('[data-modal-resize-key]')).not.toBeInTheDocument();

		const card = screen.getByText('Modal body').closest('[role="dialog"] > div');
		expect(card).toHaveStyle({ maxHeight: '70vh' });
		expect((card as HTMLElement).style.width).toContain('450px');
	});

	it('keeps close button behavior unchanged', () => {
		const { onClose } = renderModal();

		fireEvent.click(screen.getByLabelText('Close modal'));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps backdrop close behavior opt-in', () => {
		const { onClose } = renderModal({ closeOnBackdropClick: true });

		fireEvent.click(screen.getByText('Modal body'));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('shared-modal-overlay'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('routes Escape through LayerStack', async () => {
		const { onClose } = renderModal();

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus management', () => {
		it('should focus initial focus ref when provided', async () => {
			const onClose = vi.fn();

			const TestComponent = () => {
				const inputRef = React.useRef<HTMLInputElement>(null);
				return (
					<Modal
						theme={mockTheme_1}
						title="Focus Test"
						priority={100}
						onClose={onClose}
						initialFocusRef={inputRef}
					>
						<input ref={inputRef} data-testid="focus-input" />
					</Modal>
				);
			};

			render(
				<LayerStackProvider>
					<TestComponent />
				</LayerStackProvider>
			);

			await waitFor(() => {
				expect(screen.getByTestId('focus-input')).toHaveFocus();
			});
		});

		it('should focus container when no initial focus ref is provided', async () => {
			const onClose = vi.fn();

			render(
				<LayerStackProvider>
					<Modal
						theme={mockTheme_1}
						title="Container Focus"
						priority={100}
						onClose={onClose}
						testId="modal-container"
					>
						<p>Content</p>
					</Modal>
				</LayerStackProvider>
			);

			await waitFor(() => {
				expect(screen.getByTestId('modal-container')).toHaveFocus();
			});
		});
	});

	describe('layer options', () => {
		it('should pass layer options to useModalLayer', () => {
			const onClose = vi.fn();
			const onBeforeClose = vi.fn().mockResolvedValue(false);

			render(
				<LayerStackProvider>
					<Modal
						theme={mockTheme_1}
						title="Options Test"
						priority={100}
						onClose={onClose}
						layerOptions={{
							isDirty: true,
							onBeforeClose,
							focusTrap: 'lenient',
						}}
					>
						<p>Content</p>
					</Modal>
				</LayerStackProvider>
			);

			// Modal should render successfully with options
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	it('applies a remembered size to the card', () => {
		useSettingsStore.setState({
			modalSizes: { 'shared-modal-test': { width: 700, height: 500 } },
		});
		renderModal();

		const card = screen.getByText('Modal body').closest('[role="dialog"] > div');
		expect(card).toHaveStyle({ width: '700px', height: '500px' });
	});

	describe('portal', () => {
		const renderInHost = (props: Partial<React.ComponentProps<typeof Modal>> = {}) =>
			render(
				<div data-testid="host">
					<Modal
						theme={mockTheme_1}
						title="Portaled"
						priority={100}
						onClose={vi.fn()}
						testId="portal-overlay"
						{...props}
					>
						<p>Content</p>
					</Modal>
				</div>,
				{ wrapper: LayerStackWrapper }
			);

		it('should render in place by default', () => {
			renderInHost();

			const host = screen.getByTestId('host');
			expect(host).toContainElement(screen.getByTestId('portal-overlay'));
		});

		it('should escape the host subtree when portal is set', () => {
			// The Main Panel wraps the session view in `isolate`, a stacking
			// context that traps the backdrop's z-index and lets the Left/Right
			// panels paint over it. jsdom has no layout engine, so assert the
			// overlay is NOT a descendant of its host rather than checking paint
			// order - toBeInTheDocument() would pass either way.
			renderInHost({ portal: true });

			const overlay = screen.getByTestId('portal-overlay');
			expect(screen.getByTestId('host')).not.toContainElement(overlay);
			expect(overlay.parentElement).toBe(document.body);
		});

		it('should still close on Escape through the layer stack when portaled', async () => {
			const onClose = vi.fn();
			renderInHost({ portal: true, onClose });

			// React context flows through portals, so useModalLayer registration
			// is unaffected by the DOM relocation.
			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalled());
		});
	});

	describe('floating mode', () => {
		it('drops the backdrop and lets clicks through to the app behind it', () => {
			renderModal({
				floating: { position: { x: 40, y: 60 }, onMovePointerDown: vi.fn() },
			});

			const overlay = screen.getByTestId('shared-modal-overlay');
			// Click-through layer, no dimming, and not a modal to assistive tech:
			// the user is expected to keep working beside it.
			expect(overlay).toHaveClass('pointer-events-none');
			expect(overlay).not.toHaveClass('modal-overlay');
			expect(overlay).not.toHaveAttribute('aria-modal');

			const card = overlay.querySelector('[data-modal-resize-key]') as HTMLElement;
			expect(card).toHaveClass('pointer-events-auto');
			expect(card).toHaveStyle({ left: '40px', top: '60px' });
		});

		it('offers only the edges a top-left-pinned window can grow from', () => {
			renderModal({
				floating: { position: { x: 0, y: 0 }, onMovePointerDown: vi.fn() },
			});

			for (const direction of ['e', 'se', 's']) {
				expect(screen.getByTestId(`modal-resize-handle-${direction}`)).toBeInTheDocument();
			}
			// A north/west drag cannot be honored without also moving the window, so
			// those handles are not offered rather than silently acting like their
			// opposite edge.
			for (const direction of ['n', 'ne', 'w', 'nw', 'sw']) {
				expect(screen.queryByTestId(`modal-resize-handle-${direction}`)).not.toBeInTheDocument();
			}
		});

		it('makes the header a drag handle without eating its buttons', () => {
			const onMovePointerDown = vi.fn();
			const onClose = vi.fn();
			renderModal({ floating: { position: { x: 0, y: 0 }, onMovePointerDown }, onClose });

			const handle = screen.getByTestId('modal-float-handle');
			fireEvent.pointerDown(handle);
			expect(onMovePointerDown).toHaveBeenCalled();

			// The close button lives inside the drag handle and must still click.
			fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
			expect(onClose).toHaveBeenCalled();
		});

		it('still closes on Escape, so the passive layer keeps its way out', async () => {
			const onClose = vi.fn();
			renderModal({ floating: { position: { x: 0, y: 0 }, onMovePointerDown: vi.fn() }, onClose });

			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalled());
		});

		it('keeps a docked modal blocking, so floating is opt-in', () => {
			renderModal();

			const overlay = screen.getByTestId('shared-modal-overlay');
			expect(overlay).toHaveClass('modal-overlay');
			expect(overlay).toHaveAttribute('aria-modal', 'true');
			expect(screen.queryByTestId('modal-float-handle')).not.toBeInTheDocument();
			expect(screen.getByTestId('modal-resize-handle-nw')).toBeInTheDocument();
		});
	});
	describe('ModalFooter type scale', () => {
		/**
		 * These buttons carried no size class, so they took the interface font
		 * size directly - at a 16px setting with a 1.2 zoom that is over 19px,
		 * which made a two-word button larger than the modal's own `text-sm`
		 * title and gave a routine confirmation the weight of a warning.
		 */
		function renderFooter(overrides: Partial<React.ComponentProps<typeof ModalFooter>> = {}) {
			render(
				<ModalFooter
					theme={mockTheme_1}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
					cancelLabel="Cancel"
					confirmLabel="Remove"
					{...overrides}
				/>
			);
		}

		it('sizes both buttons explicitly rather than inheriting', () => {
			renderFooter();

			for (const name of ['Cancel', 'Remove']) {
				expect(screen.getByRole('button', { name }).className).toContain('text-sm');
			}
		});

		it('does not render a button larger than the modal title', () => {
			// The title is `text-sm`; a control should not outweigh the heading
			// that names what it acts on.
			renderModal({
				title: 'Remove Queued Message?',
				footer: (
					<ModalFooter
						theme={mockTheme_1}
						onCancel={vi.fn()}
						onConfirm={vi.fn()}
						confirmLabel="Remove"
					/>
				),
			});

			const title = screen.getByText('Remove Queued Message?');
			const button = screen.getByRole('button', { name: 'Remove' });
			expect(title.className).toContain('text-sm');
			expect(button.className).toContain('text-sm');
		});

		it('keeps the destructive styling independent of the size', () => {
			// Shrinking the label must not quietly change what the button means.
			renderFooter({ destructive: true, confirmLabel: 'Remove' });
			const button = screen.getByRole('button', { name: 'Remove' });

			expect(button.className).toContain('text-sm');
			expect(button).toHaveStyle({ backgroundColor: mockTheme_1.colors.error });
		});

		it('tightens the vertical padding to match', () => {
			// Otherwise the box stays tall around smaller text and the button
			// looks loose rather than smaller.
			renderFooter();
			expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('py-1.5');
		});
	});
});

// ===== from src/__tests__/renderer/components/ui/RecordDetailModal.test.tsx =====

// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

/**
 * The shared record view, tested at the seam the CSV suite cannot see.
 *
 * `CsvTableRenderer.test.tsx` already drives the body of this component through
 * the CSV adapter - filtering, row stepping, the keyboard model. What that
 * suite cannot cover is the part that made it shared in the first place: a
 * second caller supplying its own field mapping, test ids, and modal priority.
 * Those props are what stop the parquet viewer and the CSV table from fighting
 * over one hard-coded identity, so they get their own assertions here.
 */

const FIELDS = [
	{ key: 'id', value: '42' },
	{ key: 'region', value: 'eu' },
	{ key: 'notes', value: 'line one\nline two' },
];

function renderModal_1(overrides: Partial<React.ComponentProps<typeof RecordDetailModal>> = {}) {
	return render(
		<LayerStackProvider>
			<RecordDetailModal
				fields={FIELDS}
				index={0}
				total={3}
				onNavigate={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme_2}
				priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
				resizeKey="test-record-detail"
				testIdPrefix="test-record"
				{...overrides}
			/>
		</LayerStackProvider>
	);
}

describe('RecordDetailModal', () => {
	it('renders the caller-supplied fields rather than deriving them itself', () => {
		renderModal_1();

		expect(screen.getByText('id')).toBeInTheDocument();
		expect(screen.getByText('region')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
		expect(screen.getByText('eu')).toBeInTheDocument();
	});

	it('namespaces every test id under the caller prefix', () => {
		// The whole point of the prefix: two surfaces can have a record modal
		// open in the same app without a test targeting "whichever one is up".
		renderModal_1();

		expect(screen.getByTestId('test-record-modal')).toBeInTheDocument();
		expect(screen.getByTestId('test-record-search')).toBeInTheDocument();
		expect(screen.getByTestId('test-record-fields')).toBeInTheDocument();
		expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
	});

	it('shows the position within the rows the table is currently displaying', () => {
		renderModal_1({ index: 1, total: 3 });

		expect(screen.getByText('Row 2')).toBeInTheDocument();
		expect(screen.getByText(/of 3/)).toBeInTheDocument();
	});

	it('filters on both field names and values', () => {
		renderModal_1();

		fireEvent.change(screen.getByTestId('test-record-search'), { target: { value: 'region' } });
		expect(screen.getByText('region')).toBeInTheDocument();
		expect(screen.queryByText('42')).not.toBeInTheDocument();

		// Matching a VALUE keeps its field visible too - a record view is read by
		// value at least as often as by field name.
		fireEvent.change(screen.getByTestId('test-record-search'), { target: { value: '42' } });
		expect(screen.getByText('id')).toBeInTheDocument();
		expect(screen.queryByText('eu')).not.toBeInTheDocument();
	});

	it('steps rows with Left and Right without closing', () => {
		const onNavigate = vi.fn();
		const onClose = vi.fn();
		renderModal_1({ index: 1, total: 3, onNavigate, onClose });

		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
		expect(onNavigate).toHaveBeenCalledWith(2);

		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
		expect(onNavigate).toHaveBeenCalledWith(0);

		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not step past either end of the displayed rows', () => {
		const onNavigate = vi.fn();
		const { unmount } = renderModal_1({ index: 0, total: 3, onNavigate });
		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
		expect(onNavigate).not.toHaveBeenCalled();
		unmount();

		renderModal_1({ index: 2, total: 3, onNavigate });
		fireEvent.keyDown(screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it('renders an empty value as a placeholder instead of a blank row', () => {
		renderModal_1({ fields: [{ key: 'notes', value: '' }] });

		expect(screen.getByText('notes')).toBeInTheDocument();
		expect(screen.getByText('empty')).toBeInTheDocument();
	});
});
