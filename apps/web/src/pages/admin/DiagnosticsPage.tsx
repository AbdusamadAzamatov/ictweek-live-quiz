import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Panel } from '../../components/Panel';

type Diagnostics = {
  uptimeSec: number;
  memory: Record<string, number>;
  db: { ok: boolean; latencyMs: number };
  sockets: { total: number; byRole: Record<string, number> };
  rooms: { active: number; list: unknown[] };
  recentErrors: Array<{ at: string; message: string }>;
};

export function DiagnosticsPage() {
  const diag = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api<Diagnostics>('/diagnostics'),
    refetchInterval: 10_000,
  });

  if (diag.isLoading) return <p className="text-white/60">Loading…</p>;
  if (diag.error || !diag.data) return <p className="text-danger">Could not load diagnostics.</p>;
  const d = diag.data;

  const rows: Array<[string, string]> = [
    ['Uptime', `${d.uptimeSec}s`],
    ['Memory (RSS)', `${Math.round((d.memory.rss ?? 0) / 1024 / 1024)} MB`],
    ['Database', d.db.ok ? `ok (${d.db.latencyMs} ms)` : 'unreachable'],
    ['Sockets', `${d.sockets.total}`],
    ['Rooms', `${d.rooms.active}`],
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-black">Diagnostics</h1>
      <Panel>
        <table className="w-full text-left">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b border-white/10 last:border-0">
                <td className="py-3 pr-4 text-white/60">{k}</td>
                <td className="py-3 font-mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel>
        <h2 className="mb-3 text-xl font-bold">Recent errors</h2>
        {d.recentErrors.length === 0 ? (
          <p className="text-white/60">None.</p>
        ) : (
          <ul className="flex flex-col gap-2 font-mono text-sm">
            {d.recentErrors.map((e, i) => (
              <li key={i} className="text-danger/90">
                <span className="text-white/40">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
