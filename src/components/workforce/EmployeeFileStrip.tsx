import { useEffect, useState } from 'react';
import { supabase } from '../../supabase';
import type { DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { DetailTile } from '../../design/primitives';

// Employee File strip — the at-a-glance answer to "does this employee have a
// real job?": their standard procedure, the systems they work in, the
// objectives they're carrying, and how much trust they've earned. Sits at the
// top of the per-DE profile (north-star: an employee, not a settings page).
// Design System v1 pilot surface.

interface SopInfo { name: string; status: string }
interface FileFacts {
  sops: SopInfo[];
  systems: { total: number; operable: number };
  objectivesLive: number;
  loaded: boolean;
}

const TRUST_STYLE: Record<string, string> = {
  supervised: 'text-dt-body',
  established: 'text-dt-info',
  trusted: 'text-dt-accent-text',
  autonomous: 'text-dt-ok',
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
      <DetailTile label="Standard procedure">
        {!facts.loaded ? <Dim>…</Dim>
          : published.length > 0 ? (
            <>
              <span className="text-sm font-medium text-dt-title truncate block">{published[0].name}</span>
              <span className="text-[11px] text-dt-ok">published{published.length > 1 ? ` +${published.length - 1} more` : ''}{drafts.length > 0 ? ` · ${drafts.length} draft` : ''}</span>
            </>
          ) : drafts.length > 0 ? (
            <>
              <span className="text-sm font-medium text-dt-title truncate block">{drafts[0].name}</span>
              <span className="text-[11px] text-dt-warn">draft — awaiting review</span>
            </>
          ) : <Dim>None attached yet</Dim>}
      </DetailTile>
      <DetailTile label="Connected systems">
        {!facts.loaded ? <Dim>…</Dim>
          : facts.systems.total > 0 ? (
            <>
              <span className="text-sm font-medium text-dt-title">{facts.systems.total} connected</span>
              <span className="text-[11px] text-dt-support block">{facts.systems.operable > 0 ? `${facts.systems.operable} operable via browser` : 'read/write via connectors'}</span>
            </>
          ) : <Dim>None yet</Dim>}
      </DetailTile>
      <DetailTile label="Objectives in flight">
        {!facts.loaded ? <Dim>…</Dim>
          : facts.objectivesLive > 0
            ? <span className="text-sm font-medium text-dt-title">{facts.objectivesLive} live</span>
            : <Dim>None right now</Dim>}
      </DetailTile>
      <DetailTile label="Trust level">
        <span className={`text-sm font-medium capitalize ${TRUST_STYLE[trust] ?? 'text-dt-body'}`}>{trust}</span>
        <span className="text-[11px] text-dt-muted block">earned through evidence</span>
      </DetailTile>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-dt-muted">{children}</span>;
}
