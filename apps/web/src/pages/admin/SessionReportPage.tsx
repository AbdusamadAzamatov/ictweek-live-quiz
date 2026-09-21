import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { answerStyle } from '../../lib/answers';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';

type Report = {
  session: {
    id: string;
    pin: string;
    title: string;
    state: string;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    participantCount: number;
    questionCount: number;
    scoredQuestionCount: number;
  };
  standings: Array<{
    rank: number;
    participantId: string;
    nickname: string;
    score: number;
    correctCount: number;
    answeredCount: number;
    totalResponseMs: number;
    avgResponseMs: number;
  }>;
  questions: Array<{
    index: number;
    attemptId: string;
    type: string;
    text: string;
    options: Array<{ id: string; index: number; text: string; isCorrect: boolean }>;
    correctOptionIds: string[];
    eligible: number;
    answered: number;
    correctCount: number | null;
    accuracyPct: number | null;
    avgResponseMs: number;
    distribution: Array<{ optionId: string; count: number }>;
  }>;
  responses: Array<{
    participantId: string;
    nickname: string;
    questionIndex: number;
    optionIds: string[];
    optionLabels: string[];
    isCorrect: boolean;
    points: number;
    responseTimeMs: number;
    receivedAt: string;
  }>;
};

const PAGE_SIZE = 100;
const th = 'px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-white/50';
const td = 'px-3 py-2 border-t border-white/10';

export function SessionReportPage() {
  const { id = '' } = useParams();
  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api<Report>(`/sessions/${id}/report`),
    retry: false,
  });
  const [participantFilter, setParticipantFilter] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const all = report.data?.responses ?? [];
    return participantFilter ? all.filter((r) => r.participantId === participantFilter) : all;
  }, [report.data, participantFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (report.isLoading) return <p className="text-white/60">Loading report…</p>;
  if (report.error || !report.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-danger">Report not found.</p>
        <Link to="/admin" className="text-cyan underline">
          ← Library
        </Link>
      </div>
    );
  }
  const r = report.data;
  const s = r.session;
  const pollIndexes = new Set(
    r.questions.filter((q) => q.type === 'POLL').map((q) => q.index),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/admin" className="text-sm text-white/60 hover:text-white">
          ← Library
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-black">{s.title || 'Session report'}</h1>
          <p className="text-white/60">
            PIN <span className="font-mono font-bold">{s.pin}</span> ·{' '}
            {new Date(s.createdAt).toLocaleString()} · {s.participantCount} players ·{' '}
            {s.questionCount} slides ({s.scoredQuestionCount} scored) ·{' '}
            <span className="font-bold">{s.state}</span>
          </p>
        </div>
        <a href={`/api/sessions/${id}/report.csv`} download>
          <Button variant="ghost">Download CSV</Button>
        </a>
      </div>

      <Panel>
        <h2 className="mb-3 text-xl font-black">Standings</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>#</th>
                <th className={th}>Nickname</th>
                <th className={`${th} text-right`}>Score</th>
                <th className={`${th} text-right`}>Correct</th>
                <th className={`${th} text-right`}>Answered</th>
                <th className={`${th} text-right`}>Avg ms</th>
              </tr>
            </thead>
            <tbody>
              {r.standings.map((p) => (
                <tr key={p.participantId}>
                  <td className={`${td} font-black text-cyan`}>{p.rank}</td>
                  <td className={`${td} font-bold`}>{p.nickname}</td>
                  <td className={`${td} text-right tabular-nums`}>{p.score}</td>
                  <td className={`${td} text-right tabular-nums`}>{p.correctCount}</td>
                  <td className={`${td} text-right tabular-nums`}>{p.answeredCount}</td>
                  <td className={`${td} text-right tabular-nums`}>{p.avgResponseMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {r.questions.map((q) => {
          const max = Math.max(1, ...q.distribution.map((d) => d.count));
          return (
            <Panel key={q.index}>
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white/50 uppercase">
                    Q{q.index + 1} · {q.type}
                  </p>
                  <h3 className="break-words text-lg font-black">{q.text}</h3>
                </div>
                <div className="shrink-0 text-right text-sm text-white/70">
                  <p>
                    {q.accuracyPct === null ? (
                      <span className="font-black text-cyan">poll</span>
                    ) : (
                      <>
                        <span className="font-black text-success">{q.accuracyPct}%</span>{' '}
                        correct
                      </>
                    )}
                  </p>
                  <p>
                    {q.answered}/{q.eligible} answered · avg {q.avgResponseMs} ms
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {q.options.map((o) => {
                  const st = answerStyle(o.index);
                  const count = q.distribution.find((d) => d.optionId === o.id)?.count ?? 0;
                  return (
                    <div key={o.id} className="flex items-center gap-2">
                      <div
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-bold"
                        style={{
                          backgroundColor: st.color,
                          color: st.darkText ? '#001C5D' : '#fff',
                          opacity: o.isCorrect ? 1 : 0.5,
                        }}
                      >
                        <span>{st.shape}</span>
                        <span>{st.letter}</span>
                        <span className="min-w-0 flex-1 truncate">{o.text}</span>
                        {o.isCorrect && <span>✓</span>}
                      </div>
                      <div className="w-28 shrink-0">
                        <div
                          className="h-4 rounded bg-cyan/80"
                          style={{ width: `${Math.max(3, (count / max) * 100)}%` }}
                        />
                      </div>
                      <span className="w-8 text-right text-sm tabular-nums">{count}</span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-black">Responses ({filtered.length})</h2>
          <select
            value={participantFilter}
            onChange={(e) => {
              setParticipantFilter(e.target.value);
              setPage(0);
            }}
            className="rounded-lg border border-white/15 bg-navy px-3 py-1.5 text-sm"
          >
            <option value="">All participants</option>
            {r.standings.map((p) => (
              <option key={p.participantId} value={p.participantId}>
                {p.nickname}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Nickname</th>
                <th className={th}>Q#</th>
                <th className={th}>Answer(s)</th>
                <th className={th}>Correct</th>
                <th className={`${th} text-right`}>Points</th>
                <th className={`${th} text-right`}>Response ms</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((resp, i) => (
                <tr key={`${resp.participantId}-${resp.questionIndex}-${i}`}>
                  <td className={`${td} font-bold`}>{resp.nickname}</td>
                  <td className={`${td} tabular-nums`}>{resp.questionIndex + 1}</td>
                  <td className={td}>{resp.optionLabels.join(', ')}</td>
                  <td className={td}>
                    {pollIndexes.has(resp.questionIndex)
                      ? 'n/a'
                      : resp.isCorrect
                        ? '✓'
                        : '✗'}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{resp.points}</td>
                  <td className={`${td} text-right tabular-nums`}>{resp.responseTimeMs}</td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr>
                  <td className={`${td} text-white/50`} colSpan={6}>
                    No responses.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="mt-3 flex items-center justify-center gap-3 text-sm">
            <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
              ← Prev
            </Button>
            <span className="text-white/60">
              Page {page + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(page + 1)}
            >
              Next →
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
