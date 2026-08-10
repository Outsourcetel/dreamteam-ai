import React, { useRef, useState } from 'react';
import { supabase } from '../supabase';
import { PanelCard, Button, Banner, Chip } from '../design/primitives';

// Load your books by CSV (founder decision 2026-08-11: the real books live
// outside ERPNext, so the first load arrives here; the ERPNext connector
// stays for system sync). Three kinds — invoices, agreements, contacts —
// all handled by ONE gated RPC (import_books_rows, mig 686): tenant from
// auth, owner/admin only, per-row validation with loud errors, idempotent
// re-import. The card parses the CSV in the browser, sends rows in batches,
// and reports exactly what happened — created / updated / every failed row
// with its reason. It never dresses a partial import up as a full one.

type Kind = 'invoices' | 'agreements' | 'contacts';

const KINDS: Record<Kind, { label: string; required: string[]; optional: string[]; hint: string }> = {
  invoices: {
    label: 'Open invoices',
    required: ['invoice_ref', 'customer', 'amount', 'currency', 'due_date'],
    optional: ['status', 'contact_email'],
    hint: 'status is open, paid or overdue (default open); due_date is YYYY-MM-DD. Balances stay "unverified" until payments are reconciled — the import never invents a paid amount.',
  },
  agreements: {
    label: 'Agreements (renewal book)',
    required: ['customer', 'title', 'currency'],
    optional: ['agreement_type', 'status', 'value', 'start_date', 'end_date', 'renewal_date', 'auto_renew', 'notice_period_days'],
    hint: 'renewal_date is required for active agreements — it is what the renewal watchers run on. agreement_type defaults to subscription.',
  },
  contacts: {
    label: 'Customer contacts',
    required: ['customer', 'email'],
    optional: ['first_name', 'last_name', 'phone', 'role', 'is_primary'],
    hint: 'is_primary true makes this the account’s primary contact (replacing any previous primary) — the address collection chases actually email.',
  },
};

/** Minimal quote-aware CSV parser: handles quoted fields, "" escapes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

interface ImportOutcome {
  created: number; updated: number; accountsCreated: number;
  errors: { row: number; reason: string }[];
  rowsSent: number;
}

export default function BooksImportCard() {
  const [kind, setKind] = useState<Kind>('invoices');
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const spec = KINDS[kind];

  const pickKind = (k: Kind) => {
    setKind(k); setRows(null); setFileName(''); setProblem(null); setOutcome(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const onFile = async (f: File | undefined) => {
    setProblem(null); setOutcome(null); setRows(null);
    if (!f) return;
    setFileName(f.name);
    const parsed = parseCsv(await f.text());
    if (parsed.length < 2) { setProblem('That file has no data rows — the first line must be the column headers.'); return; }
    const headers = parsed[0].map(h => h.trim().toLowerCase());
    const missing = spec.required.filter(c => !headers.includes(c));
    if (missing.length) {
      setProblem(`Missing required column(s): ${missing.join(', ')}. Expected headers: ${[...spec.required, ...spec.optional].join(', ')}.`);
      return;
    }
    setRows(parsed.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))));
  };

  const runImport = async () => {
    if (!rows?.length || busy) return;
    setBusy(true); setProblem(null); setOutcome(null);
    const total: ImportOutcome = { created: 0, updated: 0, accountsCreated: 0, errors: [], rowsSent: rows.length };
    try {
      for (let off = 0; off < rows.length; off += 500) {
        const batch = rows.slice(off, off + 500);
        // ⚠ .rpc() RESOLVES on a Postgres error, and the RPC refuses in its
        // payload — classify BOTH, never report a refusal as success.
        const { data, error } = await supabase.rpc('import_books_rows', { p_kind: kind, p_rows: batch });
        if (error) throw new Error(error.message);
        const r = data as { ok?: boolean; error?: string; detail?: string; created?: number; updated?: number; accounts_created?: number; errors?: { row: number; reason: string }[] } | null;
        if (!r?.ok) {
          throw new Error(r?.error === 'not_permitted'
            ? 'only owners and admins can import the books'
            : `${r?.error ?? 'unknown refusal'}${r?.detail ? ` — ${r.detail}` : ''}`);
        }
        total.created += r.created ?? 0;
        total.updated += r.updated ?? 0;
        total.accountsCreated += r.accounts_created ?? 0;
        for (const e of r.errors ?? []) total.errors.push({ row: e.row + off, reason: e.reason });
      }
      setOutcome(total);
    } catch (e) {
      setProblem(`Import stopped: ${e instanceof Error ? e.message : String(e)}. Rows already imported stayed imported — re-running the same file is safe (it updates, never duplicates).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelCard title="Load your books" badge={<Chip tone="accent">first load</Chip>}>
      <p className="text-xs text-dt-muted mb-3 max-w-2xl">
        Bring the real business in by CSV — open invoices, agreements (the renewal book), and customer
        contacts. Re-importing the same file is safe: existing rows are updated, never duplicated. The
        ERPNext connection keeps syncing separately.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {(Object.keys(KINDS) as Kind[]).map(k => (
          <Button key={k} kind={k === kind ? 'primary' : 'ghost'} size="sm" onClick={() => pickKind(k)}>
            {KINDS[k].label}
          </Button>
        ))}
      </div>

      <p className="text-[11px] text-dt-support mb-1">
        Required columns: <span className="font-mono">{spec.required.join(', ')}</span>
        {spec.optional.length > 0 && <> · optional: <span className="font-mono">{spec.optional.join(', ')}</span></>}
      </p>
      <p className="text-[11px] text-dt-muted mb-3">{spec.hint}</p>

      <div className="flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label={`${spec.label} CSV file`}
          onChange={e => void onFile(e.target.files?.[0])}
          className="text-xs text-dt-support file:mr-3 file:rounded-lg file:border file:border-dt-border-strong file:bg-dt-inset file:px-3 file:py-1.5 file:text-xs file:text-dt-body file:cursor-pointer" />
        {rows && (
          <>
            <Chip tone="info">{rows.length} row{rows.length === 1 ? '' : 's'} parsed{fileName ? ` — ${fileName}` : ''}</Chip>
            <Button kind="primary" size="sm" disabled={busy} onClick={() => void runImport()}>
              {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            </Button>
          </>
        )}
      </div>

      {problem && <Banner tone="danger" className="mt-3">{problem}</Banner>}

      {outcome && (
        <div className="mt-3 space-y-2">
          <Banner tone={outcome.errors.length === 0 ? 'neutral' : 'info'}>
            {outcome.created} created, {outcome.updated} updated
            {outcome.accountsCreated > 0 && <> · {outcome.accountsCreated} new customer account{outcome.accountsCreated === 1 ? '' : 's'}</>}
            {outcome.errors.length > 0
              ? <> · <strong>{outcome.errors.length} of {outcome.rowsSent} rows failed</strong> — fix them in the file and re-import; the rows above are already in.</>
              : <> · all {outcome.rowsSent} rows landed.</>}
          </Banner>
          {outcome.errors.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-dt-border bg-dt-inset p-2">
              {outcome.errors.map((e, i) => (
                <p key={i} className="text-[11px] text-dt-support">
                  <span className="font-mono text-dt-muted">row {e.row}</span> — {e.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </PanelCard>
  );
}
