import React from 'react';
import { Modal as DtModal } from '../design/primitives';

// LEGACY ADAPTER — old default-export Modal call sites now render the Design
// System v1 Modal (docs/design-system.md). New code should import { Modal }
// from src/design/primitives directly.
const Modal = ({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) => (
  <DtModal title={title} onClose={onClose}>{children}</DtModal>
);

export default Modal;
