import React, { useState } from 'react';
import Modal from './Modal';

// Shared confirm-before-destroy dialog — added during a pre-launch readiness
// review after finding several irreversible one-click actions (remove
// playbook assignment, remove data source, delete media, delete document,
// delete golden question) with zero confirmation step anywhere in the app,
// inconsistent with how carefully other actions are gated elsewhere.
const ConfirmDeleteModal = ({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) => {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <div className="space-y-4">
        <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmDeleteModal;
