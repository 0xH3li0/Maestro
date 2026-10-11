import React, { memo, useRef, useCallback } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface ConfirmModalProps {
	theme: Theme;
	message: string;
	onConfirm: (() => void) | null;
	onClose: () => void;
	title?: string;
	headerIcon?: React.ReactNode;
	icon?: React.ReactNode;
	destructive?: boolean;
	confirmLabel?: string;
	/** Detail drawn under the message: a list of what the confirmation covers. */
	children?: React.ReactNode;
	width?: number;
	/** Raise the dialog over a modal that sits above the default layer. */
	zIndex?: number;
}

export const ConfirmModal = memo(function ConfirmModal({
	theme,
	message,
	onConfirm,
	onClose,
	title = 'Confirm',
	headerIcon,
	icon,
	destructive = true,
	confirmLabel,
	children,
	width = 450,
	zIndex = 10000,
}: ConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		if (onConfirm) {
			onConfirm();
		}
		onClose();
	}, [onConfirm, onClose]);

	const iconColor = destructive ? theme.colors.error : theme.colors.warning;

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={headerIcon ?? <Trash2 className="w-4 h-4" style={{ color: iconColor }} />}
			width={width}
			zIndex={zIndex}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					destructive={destructive}
					confirmLabel={confirmLabel}
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${iconColor}20` }}
				>
					{icon ?? <AlertTriangle className="w-5 h-5" style={{ color: iconColor }} />}
				</div>
				{children ? (
					<div className="min-w-0 flex-1 space-y-3">
						<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
							{message}
						</p>
						{children}
					</div>
				) : (
					<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
						{message}
					</p>
				)}
			</div>
		</Modal>
	);
});
