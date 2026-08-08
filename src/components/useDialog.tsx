import React, { useCallback, useRef, useState } from 'react';
import { Modal, Button, Field, INPUT_CLS } from '../design/primitives';

// ════════════════════════════════════════════════════════════════════════
// ASK THE USER SOMETHING, WITHOUT HANDING THE PAGE BACK TO THE BROWSER.
//
// Twelve call sites across six pages still used window.confirm and
// window.prompt. They are the operating system's chrome dropped into the
// middle of a designed product, and the problems are not cosmetic:
//
//   · unstyled and unthemed — light-mode grey in a dark application
//   · untranslatable, and the button words are the OS's, not ours
//   · no room to explain a consequence beyond one line of plain text
//   · the destructive button gets default focus, so Enter destroys
//   · some browsers let a user suppress them entirely, after which the
//     "are you sure?" silently answers itself
//
// The awkward part of replacing them is that window.confirm is SYNCHRONOUS
// in the middle of a handler, while a real dialog is state plus a render.
// These hooks keep the call site's shape — `if (!await confirm({…})) return;`
// — so the surrounding logic does not have to be turned inside out, which is
// what made these survive so many passes.
//
// Usage:
//   const { confirm, confirmUI } = useConfirm();
//   const remove = async () => {
//     if (!await confirm({ title: 'Delete it?', message: '…' })) return;
//     …
//   };
//   return (<>{…}{confirmUI}</>);
// ════════════════════════════════════════════════════════════════════════

export interface ConfirmOptions {
  title: string;
  /** What actually happens. This is the room window.confirm never gave. */
  message: React.ReactNode;
  /** The verb on the button — say the action, never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for anything that destroys or disconnects; 'primary' otherwise. */
  tone?: 'danger' | 'primary';
}

export function useConfirm() {
  const [req, setReq] = useState<ConfirmOptions | null>(null);
  const [busy, setBusy] = useState(false);
  // ⚠ Exactly one settle per ask. A dialog can be closed by the button, by
  // Escape, or by the backdrop; if the promise resolved twice the caller's
  // `await` would already have moved on and the second resolve would be lost
  // silently — or worse, a stale resolver from a previous ask would fire.
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const settle = useCallback((ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setReq(null);
    setBusy(false);
    r?.(ok);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // An ask that arrives while one is open cancels the old one rather than
    // orphaning its promise.
    resolver.current?.(false);
    setReq(opts);
    setBusy(false);
    return new Promise<boolean>(resolve => { resolver.current = resolve; });
  }, []);

  const confirmUI = req ? (
    <Modal title={req.title} size="sm" onClose={() => { if (!busy) settle(false); }}>
      <div className="space-y-4">
        <div className="text-sm text-dt-support leading-relaxed">{req.message}</div>
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy} onClick={() => settle(false)}>{req.cancelLabel ?? 'Cancel'}</Button>
          <Button
            size="sm"
            kind={req.tone === 'primary' ? 'primary' : 'danger'}
            disabled={busy}
            onClick={() => { setBusy(true); settle(true); }}
          >
            {req.confirmLabel ?? 'Yes, do it'}
          </Button>
        </div>
      </div>
    </Modal>
  ) : null;

  return { confirm, confirmUI };
}

export interface PromptOptions {
  title: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
}

/** Resolves to the trimmed string, or null if the person backed out. */
export function usePromptText() {
  const [req, setReq] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((v: string | null) => void) | null>(null);
  const settle = useCallback((v: string | null) => {
    const r = resolver.current;
    resolver.current = null;
    setReq(null);
    r?.(v);
  }, []);

  const promptText = useCallback((opts: PromptOptions) => {
    resolver.current?.(null);
    setValue(opts.initialValue ?? '');
    setReq(opts);
    return new Promise<string | null>(resolve => { resolver.current = resolve; });
  }, []);

  const submit = () => { const v = value.trim(); if (v) settle(v); };

  const promptUI = req ? (
    <Modal title={req.title} size="sm" onClose={() => settle(null)}>
      <Field label={req.label}>
        <input
          autoFocus
          className={INPUT_CLS}
          value={value}
          placeholder={req.placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button size="sm" onClick={() => settle(null)}>Cancel</Button>
        <Button size="sm" kind="primary" disabled={!value.trim()} onClick={submit}>
          {req.confirmLabel ?? 'Save'}
        </Button>
      </div>
    </Modal>
  ) : null;

  return { promptText, promptUI };
}
