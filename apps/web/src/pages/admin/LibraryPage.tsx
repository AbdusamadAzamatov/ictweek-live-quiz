import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';

type QuizListItem = {
  id: string;
  title: string;
  description: string;
  coverMediaId: string | null;
  cover: { url: string; alt: string } | null;
  questionCount: number;
  updatedAt: string;
};

type SessionListItem = {
  id: string;
  pin: string;
  state: string;
  locked: boolean;
  participantCount: number;
  questionCount: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  displayKey: string;
  title: string;
};

const STATE_TONE: Record<string, string> = {
  LOBBY: 'bg-azure/20 text-azure',
  COUNTDOWN: 'bg-cyan/20 text-cyan',
  QUESTION_OPEN: 'bg-cyan/20 text-cyan',
  ANSWER_REVEAL: 'bg-warning/20 text-warning',
  LEADERBOARD: 'bg-warning/20 text-warning',
  RECOVERY: 'bg-warning/20 text-warning',
  FINISHED: 'bg-success/20 text-success',
  CANCELLED: 'bg-white/10 text-white/50',
};

export function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const quizzes = useQuery({
    queryKey: ['quizzes'],
    queryFn: () => api<{ quizzes: QuizListItem[] }>('/quizzes'),
  });
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ sessions: SessionListItem[] }>('/sessions'),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['quizzes'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const createQuiz = useMutation({
    mutationFn: () => api<{ quiz: { id: string } }>('/quizzes', { method: 'POST' }),
    onSuccess: (d) => {
      invalidate();
      navigate(`/admin/quizzes/${d.quiz.id}`);
    },
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api(`/quizzes/${id}/duplicate`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/quizzes/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const importRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importJson = async (file: File) => {
    setImportError(null);
    try {
      const body = JSON.parse(await file.text());
      await api('/quizzes/import', { method: 'POST', body });
      invalidate();
    } catch {
      setImportError('Import failed — expected an ictquiz-v1 export file.');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-3xl font-black">Quiz library</h1>
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
              }}
            />
            <Button variant="ghost" onClick={() => importRef.current?.click()}>
              Import JSON
            </Button>
            <Button onClick={() => createQuiz.mutate()} disabled={createQuiz.isPending}>
              Create quiz
            </Button>
          </div>
        </div>
        {importError && <p className="mb-4 text-danger">{importError}</p>}
        {quizzes.isLoading && <p className="text-white/60">Loading…</p>}
        {quizzes.data && quizzes.data.quizzes.length === 0 && (
          <Panel className="text-white/60">No quizzes yet — create your first one.</Panel>
        )}
        <div className="grid gap-3">
          {quizzes.data?.quizzes.map((q) => (
            <Panel key={q.id} className="flex flex-wrap items-center gap-3">
              {q.cover && (
                <img
                  src={q.cover.url}
                  alt={q.cover.alt}
                  className="h-14 w-20 shrink-0 rounded-lg object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <button
                  className="block truncate text-xl font-bold hover:text-cyan"
                  onClick={() => navigate(`/admin/quizzes/${q.id}`)}
                >
                  {q.title}
                </button>
                <p className="text-sm text-white/50">
                  {q.questionCount} question{q.questionCount === 1 ? '' : 's'} · updated{' '}
                  {new Date(q.updatedAt).toLocaleString()}
                </p>
              </div>
              <Button
                variant="primary"
                onClick={() => navigate(`/admin/sessions/new?quizId=${q.id}`)}
              >
                Host session
              </Button>
              <Button variant="ghost" onClick={() => navigate(`/admin/quizzes/${q.id}`)}>
                Open
              </Button>
              <a href={`/api/quizzes/${q.id}/export`} download>
                <Button variant="ghost">Export JSON</Button>
              </a>
              <Button variant="ghost" onClick={() => duplicate.mutate(q.id)}>
                Duplicate
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm(`Delete “${q.title}”?`)) remove.mutate(q.id);
                }}
              >
                Delete
              </Button>
            </Panel>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-2xl font-black">Recent sessions</h2>
        {sessions.data && sessions.data.sessions.length === 0 && (
          <Panel className="text-white/60">No sessions yet.</Panel>
        )}
        <div className="grid gap-3">
          {sessions.data?.sessions.map((s) => {
            const live = s.state !== 'FINISHED' && s.state !== 'CANCELLED';
            return (
              <Panel key={s.id} className="flex flex-wrap items-center gap-4">
                <span className="font-mono text-2xl font-black tracking-widest">{s.pin}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{s.title || 'Untitled quiz'}</p>
                  <p className="text-sm text-white/50">
                    <span
                      className={`mr-2 rounded-full px-2 py-0.5 text-xs font-bold ${STATE_TONE[s.state] ?? 'bg-white/10'}`}
                    >
                      {s.state}
                    </span>
                    {s.participantCount} players · {s.questionCount} questions ·{' '}
                    {s.startedAt ? `started ${new Date(s.startedAt).toLocaleString()}` : `created ${new Date(s.createdAt).toLocaleString()}`}
                    {s.endedAt ? ` · ended ${new Date(s.endedAt).toLocaleString()}` : ''}
                  </p>
                </div>
                {live && (
                  <Button variant="primary" onClick={() => navigate(`/admin/host/${s.id}`)}>
                    Open host
                  </Button>
                )}
                {s.startedAt && (
                  <Button
                    variant="ghost"
                    onClick={() => navigate(`/admin/sessions/${s.id}/report`)}
                  >
                    Report
                  </Button>
                )}
                <a href={`/display/${s.displayKey}`} target="_blank" rel="noreferrer">
                  <Button variant="ghost">Projector</Button>
                </a>
              </Panel>
            );
          })}
        </div>
      </section>
    </div>
  );
}
