import React, { useMemo, useState } from 'react';
import {
  parseCsv,
  importAccountsCsv,
  importTicketsCsv,
  isMissingTableError,
} from '../lib/customerApi';
import type { ImportResult } from '../lib/customerApi';
import { useVocabulary } from '../lib/vocabulary';
import type { Vocabulary } from '../lib/vocabulary';

// ============================================================
// Import Customers modal — paste or upload CSV, map columns,
// import accounts or tickets into the live tenant workspace.
// ============================================================

type Tab = 'accounts' | 'tickets';

interface FieldDef { key: string; label: string; required?: boolean; aliases: string[] }

// Wave 4: labels come from the tenant's vocabulary (aliases stay broad —
// they match incoming CSV headers, which may use any wording).
const accountFields = (v: Vocabulary): FieldDef[] => [
  { key: 'name', label: `${v.party_singular} name`, required: true, aliases: ['name', 'account', 'account name', 'company', 'customer', 'patient', 'client'] },
  { key: 'arr', label: v.value_metric, aliases: ['arr', 'arr_cents', 'annual revenue', 'revenue', 'value', 'amount'] },
  { key: 'health_score', label: 'Health (0-100)', aliases: ['health', 'health_score', 'health score', 'score'] },
  { key: 'csm', label: 'CSM', aliases: ['csm', 'owner', 'account manager', 'manager'] },
  { key: 'status', label: 'Status', aliases: ['status', 'state'] },
  { key: 'renewal_date', label: `${v.renewal_label} date (YYYY-MM-DD)`, aliases: ['renewal', 'renewal_date', 'renewal date', 'renews'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments'] },
];

const TICKET_FIELDS: FieldDef[] = [
  { key: 'subject', label: 'Subject', required: true, aliases: ['subject', 'title', 'summary', 'issue'] },
  { key: 'body', label: 'Body', aliases: ['body', 'description', 'detail', 'details'] },
  { key: 'status', label: 'Status', aliases: ['status', 'state'] },
  { key: 'priority', label: 'Priority (p1-p4)', aliases: ['priority', 'severity', 'sev'] },
  { key: 'assignee', label: 'Assignee (de/human)', aliases: ['assignee', 'assigned', 'owner'] },
];

function autoMap(headers: string[], fields: FieldDef[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of fields) {
    const idx = headers.findIndex(
      (h, i) => !used.has(i) && f.aliases.includes(h.trim().toLowerCase())
    );
    if (idx >= 0) { mapping[f.key] = idx; used.add(idx); }
  }
  return mapping;
}

export default function ImportCustomersModal({
  initialTab = 'accounts',
  onClose,
  onImported,
}: {
  initialTab?: Tab;
  onClose: () => void;
  onImported: () => void;
}) {
  const vocab = useVocabulary();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [csvText, setCsvText] = useState('');
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [mappedForText, setMappedForText] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const fields = tab === 'accounts' ? accountFields(vocab) : TICKET_FIELDS;

  const parsed = useMemo(() => {
    if (!csvText.trim()) return null;
    const rows = parseCsv(csvText);
    if (rows.length < 1) return null;
    const headers = rows[0].map(h => h.trim());
    return { headers, dataRows: rows.slice(1) };
  }, [csvText]);

  // Auto-map when a new CSV is pasted or the tab changes.
  const mapKey = tab + '::' + (parsed ? parsed.headers.join('|') : '');
  if (parsed && mappedForText !== mapKey) {
    setMapping(autoMap(parsed.headers, fields));
    setMappedForText(mapKey);
    setResult(null);
    setFatalError(null);
  }

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.readAsText(file);
  };

  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.dataRows.map(cells => {
      const obj: Record<string, string> = {};
      for (const f of fields) {
        const idx = mapping[f.key];
        if (idx !== undefined && idx >= 0) obj[f.key] = (cells[idx] ?? '').trim();
      }
      return obj;
    });
  }, [parsed, mapping, fields]);

  const requiredMapped = fields.filter(f => f.required).every(f => mapping[f.key] !== undefined && mapping[f.key] >= 0);

  const runImport = async () => {
    if (!parsed || mappedRows.length === 0) return;
    setImporting(true);
    setFatalError(null);
    setResult(null);
    try {
      const res = tab === 'accounts'
        ? await importAccountsCsv(mappedRows)
        : await importTicketsCsv(mappedRows);
      setResult(res);
      if (res.imported > 0) onImported();
    } catch (err: any) {
      setFatalError(
        isMissingTableError(err)
          ? 'Live data tables not yet provisioned — run supabase/migrations/011_customer_entity.sql first.'
          : (err?.message || 'Import failed.')
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <div>
            <h3 className="text-white font-semibold">Import customer data</h3>
            <p className="text-xs text-slate-500 mt-0.5">Paste CSV or upload a file — first row must be headers</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center text-xs">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Tabs */}
          <div className="flex gap-1 bg-slate-700 rounded-xl p-1 w-fit">
            {(['accounts', 'tickets'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setResult(null); setFatalError(null); }}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${tab === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {t === 'accounts' ? vocab.party_plural : 'Support tickets'}
              </button>
            ))}
          </div>

          {/* Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">CSV data</label>
              <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer">
                Upload file
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
                />
              </label>
            </div>
            <textarea
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              rows={5}
              placeholder={tab === 'accounts'
                ? 'name,arr,health,csm,status,renewal_date\nNorthfield Co,$210K,81,P. Sharma,active,2026-08-18'
                : 'subject,body,status,priority\nAPI auth failure,Intermittent 401s after key rotation,open,p1'}
              className="w-full bg-slate-900 border border-slate-600 text-white text-xs font-mono rounded-xl px-3 py-2.5 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Column mapping */}
          {parsed && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-2">
                Column mapping — {parsed.dataRows.length} data row{parsed.dataRows.length === 1 ? '' : 's'} detected
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {fields.map(f => (
                  <div key={f.key} className="flex items-center gap-2 bg-slate-700/60 rounded-lg px-2.5 py-1.5">
                    <span className="text-xs text-slate-300 flex-1 truncate">
                      {f.label}{f.required && <span className="text-rose-400"> *</span>}
                    </span>
                    <select
                      value={mapping[f.key] ?? -1}
                      onChange={e => setMapping(prev => ({ ...prev, [f.key]: Number(e.target.value) }))}
                      className="bg-slate-900 border border-slate-600 rounded text-xs text-white px-2 py-1 focus:outline-none focus:border-indigo-500 max-w-[140px]"
                    >
                      <option value={-1}>— skip —</option>
                      {parsed.headers.map((h, i) => (
                        <option key={i} value={i}>{h || `(column ${i + 1})`}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {!requiredMapped && (
                <p className="text-xs text-amber-400 mt-2">Map the required column(s) marked * to continue.</p>
              )}
            </div>
          )}

          {/* Preview */}
          {parsed && mappedRows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-700">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-700">
                    {fields.filter(f => mapping[f.key] !== undefined && mapping[f.key] >= 0).map(f => (
                      <th key={f.key} className="py-2 px-3 text-left text-[10px] uppercase tracking-wide text-slate-500 font-medium">{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappedRows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-b border-slate-700/60 last:border-b-0">
                      {fields.filter(f => mapping[f.key] !== undefined && mapping[f.key] >= 0).map(f => (
                        <td key={f.key} className="py-1.5 px-3 text-slate-300 truncate max-w-[160px]">{r[f.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {mappedRows.length > 5 && (
                <p className="text-[10px] text-slate-600 px-3 py-1.5">…and {mappedRows.length - 5} more row(s)</p>
              )}
            </div>
          )}

          {/* Result / errors */}
          {fatalError && (
            <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{fatalError}</div>
          )}
          {result && (
            <div className="rounded-xl border border-slate-600 bg-slate-700/60 px-4 py-3 text-xs">
              <p className="text-emerald-300 font-medium mb-1">{result.imported} row(s) imported.</p>
              {result.errors.length > 0 && (
                <div className="text-amber-300">
                  <p className="mb-1">{result.errors.length} row(s) skipped:</p>
                  <ul className="list-disc ml-4 space-y-0.5 text-amber-400/80">
                    {result.errors.slice(0, 8).map(e => (
                      <li key={e.row}>Row {e.row}: {e.message}</li>
                    ))}
                    {result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 border border-slate-600 hover:border-slate-500 transition-colors">
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={runImport}
            disabled={!parsed || mappedRows.length === 0 || !requiredMapped || importing}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {importing ? 'Importing…' : `Import ${tab === 'accounts' ? 'accounts' : 'tickets'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
