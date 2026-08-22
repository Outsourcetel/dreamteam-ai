// The schema gallery — every design-system component, on one page, with no
// signed-in session required. Reached at ?dtpreview=1 in DEV ONLY (see
// main.tsx); the branch and this import are dropped from production builds.
//
// This is where a new schema gets checked at 1024/1280/1536 before it reaches
// a real screen. Add a section here when you add a schema.
import {
  EmployeeCard, DecisionCard, FilterBar, SetupChecklist,
  Button, Chip, PanelCard, INPUT_CLS, SELECT_CLS, StatTile, DetailTile, TableScroll, TH, TD, EntityRow,
} from './primitives';
import { Sidebar } from '../components/Sidebar';
import { AuthProvider } from '../context/AuthContext';

const Avatar = ({ letter, tone }: { letter: string; tone: string }) => (
  <div className={`w-10 h-10 rounded-full grid place-items-center text-sm font-semibold shrink-0 ${tone}`}>{letter}</div>
);

export default function SchemaPreview() {
  return (
    <div className="min-h-screen bg-dt-page text-dt-body p-dt-gutter">
      <div className="max-w-dt-content mx-auto space-y-8">
        <h1 className="text-2xl font-semibold text-dt-title">v2 schemas</h1>

        <PanelCard title="EmployeeCard — working, blocked, not started">
          <div className="grid grid-cols-dt-cards gap-dt">
            <EmployeeCard
              avatar={<Avatar letter="S" tone="bg-dt-ok-soft text-dt-ok" />}
              name="Sophie" state={{ label: 'Working', tone: 'ok' }}
              role="Customer support · answering chat & email"
              stats={[
                { label: 'handled today', value: '142' },
                { label: 'closed without you', value: '96%' },
                { label: 'avg reply', value: '1.2m' },
              ]}
              lastAction="Last: replied to Meridian Group about a failed login — 4 minutes ago."
              actions={<><Button kind="secondary" size="sm">Open Sophie&rsquo;s file</Button><Button kind="ghost" size="sm">Ask her to change something</Button></>}
              onOpen={() => {}}
            />
            <EmployeeCard
              avatar={<Avatar letter="M" tone="bg-dt-warn-soft text-dt-warn" />}
              name="Marcus" state={{ label: 'Blocked', tone: 'warn' }}
              role="Billing &amp; renewals · invoices and payment chasing"
              stats={[
                { label: 'handled today', value: '31' },
                { label: 'waiting on you', value: '2' },
                { label: 'invoiced today', value: '$24k' },
              ]}
              blockedReason="Stopped: an invoice for $15,600 is over the $500 limit you set. He can't send it without you."
              actions={<><Button kind="primary" size="sm">Unblock Marcus</Button><Button kind="ghost" size="sm">Open his file</Button></>}
              onOpen={() => {}}
            />
            <SetupChecklist
              title="Nadia is hired but hasn't started"
              why="She needs a knowledge source and one playbook before she can take any work."
              items={[
                { label: 'Job described', done: true },
                { label: 'A knowledge source to answer from' },
                { label: 'One playbook to follow' },
              ]}
              action={<Button kind="primary" size="sm">Finish setting Nadia up</Button>}
              estimate="about 5 minutes"
            />
          </div>
        </PanelCard>

        <PanelCard title="DecisionCard — with a nudge, and gone quiet">
          <div className="space-y-3">
            <DecisionCard
              title="Send a $15,600 invoice to Meridian Group"
              detail="Marcus prepared it for their annual renewal. It's over the $500 limit you set, so he stopped."
              meta="Waiting 2 hours · Marcus · renewal invoice"
              actions={<><Button kind="primary" size="sm">Approve &amp; send</Button><Button kind="secondary" size="sm">See the invoice</Button><Button kind="ghost" size="sm">Don&rsquo;t</Button></>}
              nudge="You've approved every Meridian renewal for two years. Let Marcus send these himself →"
            />
            <DecisionCard
              title="Approve a knowledge fix"
              stale="Nothing's happened in 5 days"
              detail="Sophie wrote an answer for “what's your refund window”, which 14 people have asked and nobody could answer."
              meta="Waiting 5 days · Sophie · new knowledge"
              actions={<><Button kind="primary" size="sm">Read &amp; publish</Button><Button kind="secondary" size="sm">Edit first</Button></>}
            />
          </div>
        </PanelCard>

        <PanelCard title="Sidebar — full 248px, and the 56px rail">
          {/* The real component, not a copy. Counts need a session, so the
              badges are exercised on a signed-in screen; what is checked here
              is the frame: width, row rhythm, the 12px floor, the active bar,
              and the rule that matters most — 16 destinations and 5 section
              headers must fit 900px WITHOUT the nav scrolling. */}
          <AuthProvider>
            <div className="flex gap-dt" style={{ height: 900 }}>
              <Sidebar page={"dashboard" as never} setPage={() => {}}
                user={{ role: "tenant_owner", name: "Bilal Khan" }} tenant={{ name: "OutsourceTel" }}
                collapsed={false} setCollapsed={() => {}} onLogout={() => {}} />
              <Sidebar page={"dashboard" as never} setPage={() => {}}
                user={{ role: "tenant_owner", name: "Bilal Khan" }} tenant={{ name: "OutsourceTel" }}
                collapsed setCollapsed={() => {}} onLogout={() => {}} />
            </div>
          </AuthProvider>
        </PanelCard>

        <PanelCard title="v1 primitives at the 12px floor">
          {/* StatTile, DetailTile and TH carried 10–11px labels. A table is
              where lifting a column header can actually cost width, so one
              lives here to be measured rather than assumed. */}
          <div className="grid grid-cols-dt-kpis gap-dt mb-4">
            <StatTile label="handled today" value="4,180" sub="+18% on last month" />
            <StatTile label="closed without a human" value="91%" tone="ok" />
            <StatTile label="came to you" value="376" tone="warn" sub="most were the $500 limit" />
          </div>
          <div className="grid grid-cols-dt-tiles gap-dt-tight mb-4">
            <DetailTile label="reports to"><span className="text-sm text-dt-body">Bilal Khan</span></DetailTile>
            <DetailTile label="started"><span className="text-sm text-dt-body">4 Aug</span></DetailTile>
          </div>
          <TableScroll>
            <table className="w-full">
              <thead><tr>
                <th className={TH}>Customer</th><th className={TH}>Handled by</th>
                <th className={TH}>Closed without a human</th><th className={TH}>Rating</th><th className={TH}>Closed</th>
              </tr></thead>
              <tbody>
                <tr><td className={TD}>Meridian Group</td><td className={TD}>Sophie</td><td className={TD}>96%</td><td className={TD}>4.7</td><td className={TD}>10:04</td></tr>
                <tr><td className={TD}>Apex Systems</td><td className={TD}>Sophie</td><td className={TD}>96%</td><td className={TD}>4.7</td><td className={TD}>Yesterday</td></tr>
              </tbody>
            </table>
          </TableScroll>
        </PanelCard>

        <PanelCard title="EntityRow — default and selected">
          {/* dt-accent-border check: the selected row's border and the ai
              Chip/Button above both resolve --dt-accent-border, which never
              emitted CSS as `border-dt-accent/NN` (task 4b). */}
          <div className="space-y-2">
            <EntityRow title="Meridian Group" meta="Not selected" onOpen={() => {}} />
            <EntityRow title="Apex Systems" meta="Selected" selected onOpen={() => {}} />
          </div>
        </PanelCard>

        <PanelCard title="FilterBar">
          <FilterBar
            presets={<><Chip tone="accent">30 days</Chip><Chip>7 days</Chip><Chip>90 days</Chip><Chip>This year</Chip></>}
            facets={<>
              <select className={SELECT_CLS} defaultValue="" aria-label="Filter by person">
                <option value="">Everyone</option>
                <option value="me">Only me</option>
              </select>
              <select className={SELECT_CLS} defaultValue="" aria-label="Filter by source">
                <option value="">Any source</option>
                <option value="auto">Automatic</option>
              </select>
            </>}
            search={<input className={INPUT_CLS} placeholder="Search…" aria-label="Search" />}
            views={<Button kind="ghost" size="sm">Saved views</Button>}
          />
        </PanelCard>
      </div>
    </div>
  );
}
