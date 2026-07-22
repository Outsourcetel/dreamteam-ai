import { useEffect, useState } from 'react';
import { supabase } from '../../supabase';
import type { DigitalEmployee } from '../../lib/digitalEmployeesApi';

// Employee File strip — the at-a-glance answer to "does this employee have a
// real job?": their standard procedure, the systems they work in, the
// objectives they're carrying, and how much trust they've earned. Sits at the
// top of the per-DE profile (north-star: an employee, not a settings page).

interface SopInfo { name: string; status: string }
interface FileFacts {
  sops: SopInfo[];
  systems: { total: number; operable: number };
  objectivesLive: number;
  loaded: boolean;
}

const TRUST_STYLE: Record<string, string> = {
  supervised: 'text-slate-300',
  established: 'text-sky-300',
  trusted: 'text-indigo-300',
  autonomous: 'text-emerald-300',
};

const CLOSED_OBJECTIVE_STATES = ['achieved', 'closed', 'cancelled', 'done', 'retired'];

export default function EmployeeFileStrip({ de }: { de: DigitalEmployee }) {
  const [facts, setFacts] = useState<FileFacts>({ sops: [], systems: { total: 0, operable: 0 }, objectivesLive: 0, loaded: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pb, sys, obj] = await Promise.all([
        supabase.from('playbook_definitions').select('name, status').eq('de_id', de.id),
        supabase.rpc('get_de_systems', { p_de_id: de.id }),
        supabase.from('de_objectives').select('status').eq('de_id', de.id),
      ]);
      if (cancelled) return;
      const sops = ((pb.data ?? []) as SopInfo[]);
      const systems = Array.isArray(sys.data) ? sys.data as Array<{ can_operate?: boolean }> : [];
      const objectives = (obj.data ?? []) as Array<{ status: string | null }>;
      setFacts({
        sops,
        systems: { total: systems.length, operable: systems.filter(s => s.can_operate).length },
        objectivesLive: objectives.filter(o => !CLOSED_OBJECTIVE_STATES.includes(String(o.status ?? ''))).length,
        loaded: true,
      });
    })();
    return () => { cancelled = true; };
  }, [de.id]);

  const published = facts.sops.filter(s => s.status === 'published');
  const drafts = facts.sops.filter(s => s.status !== 'published');
  const trust = String(de.trust_level ?? 'supervised');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <Tile label="Standard procedure">
        {!facts.loaded ? <Dim>…</Dim>
          : published.length > 0 ? (
            <>
              <span className="text-sm font-medium text-white truncate block">{published[0].name}</span>
              <span className="text-[11px] text-emerald-400">published{published.length > 1 ? ` +${published.length - 1} more` : ''}{drafts.length > 0 ? ` · ${drafts.length} draft` : ''}</span>
            </>
          ) : drafts.length > 0 ? (
            <>
              <span className="text-sm font-medium text-white truncate block">{drafts[0].name}</span>
              <span className="text-[11px] text-amber-400">draft — awaiting review</span>
            </>
          ) : <Dim>None attached yet</Dim>}
      </Tile>
      <Tile label="Connected systems">
        {!facts.loaded ? <Dim>…</Dim>
          : facts.systems.total > 0 ? (
            <>
              <span className="text-sm font-medium text-white">{facts.systems.total} connected</span>
              <span className="text-[11px] text-slate-400 block">{facts.systems.operable > 0 ? `${facts.systems.operable} operable via browser` : 'read/write via connectors'}</span>
            </>
          ) : <Dim>None yet</Dim>}
      </Tile>
      <Tile label="Objectives in flight">
        {!facts.loaded ? <Dim>…</Dim>
          : facts.objectivesLive > 0
            ? <span className="text-sm font-medium text-white">{facts.objectivesLive} live</span>
            : <Dim>None right now</Dim>}
      </Tile>
      <Tile label="Trust level">
        <span className={`text-sm font-medium capitalize ${TRUST_STYLE[trust] ?? 'text-slate-300'}`}>{trust}</span>
        <span className="text-[11px] text-slate-500 block">earned through evidence</span>
      </Tile>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-slate-500">{children}</span>;
}
