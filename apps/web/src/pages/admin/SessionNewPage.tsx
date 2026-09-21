import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';
import type { Issue } from '@ictquiz/shared';

type Settings = {
  maxParticipants: number;
  showQuestionOnPlayer: boolean;
  randomizeQuestions: boolean;
  randomizeAnswers: boolean;
  allowLateJoin: boolean;
};

const DEFAULTS: Settings = {
  maxParticipants: 500,
  showQuestionOnPlayer: false,
  randomizeQuestions: false,
  randomizeAnswers: false,
  allowLateJoin: true,
};

export function SessionNewPage() {
  const [params] = useSearchParams();
  const quizId = params.get('quizId') ?? '';
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quiz = useQuery({
    queryKey: ['quiz', quizId],
    queryFn: () => api<{ quiz: { id: string; title: string } }>(`/quizzes/${quizId}`),
    enabled: !!quizId,
  });

  const start = async () => {
    setBusy(true);
    setError(null);
    setIssues(null);
    try {
      const res = await api<{ id: string }>('/sessions', {
        method: 'POST',
        body: { quizId, settings },
      });
      navigate(`/admin/host/${res.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const data = e.data as { playIssues?: Issue[] };
        setIssues(data.playIssues ?? []);
      } else {
        setError('Could not create the session — try again.');
      }
      setBusy(false);
    }
  };

  const toggle = (k: keyof Settings) => (
    <button
      type="button"
      role="switch"
      aria-checked={!!settings[k]}
      onClick={() => setSettings((s) => ({ ...s, [k]: !s[k] }))}
      className={`h-7 w-12 rounded-full transition ${settings[k] ? 'bg-success' : 'bg-white/15'}`}
    >
      <span
        className={`block h-6 w-6 rounded-full bg-white transition ${settings[k] ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  );

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <Link to="/admin" className="text-sm text-white/60 hover:text-white">
        ← Library
      </Link>
      <h1 className="text-3xl font-black">Host a session</h1>
      <p className="text-white/70">
        Quiz: <span className="font-bold">{quiz.data?.quiz.title ?? '…'}</span>
      </p>

      <Panel className="flex flex-col gap-5">
        <div>
          <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-white/50">
            Max participants
          </label>
          <input
            type="number"
            min={1}
            max={2000}
            className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2"
            value={settings.maxParticipants}
            onChange={(e) =>
              setSettings((s) => ({ ...s, maxParticipants: Number(e.target.value) || 1 }))
            }
          />
        </div>
        {(
          [
            ['showQuestionOnPlayer', 'Show question text on phones'],
            ['randomizeQuestions', 'Randomize question order'],
            ['randomizeAnswers', 'Randomize answer order'],
            ['allowLateJoin', 'Allow late join'],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <span className="font-semibold">{label}</span>
            {toggle(k)}
          </div>
        ))}
      </Panel>

      {issues && (
        <Panel className="border border-warning/40 bg-warning/10">
          <p className="mb-2 font-bold text-warning">This quiz is not playable yet:</p>
          {issues.map((i) => (
            <p key={i.path} className="text-sm text-warning">
              • {i.questionIndex !== undefined ? `Q${i.questionIndex + 1}: ` : ''}
              {i.message}
            </p>
          ))}
          <Link
            to={`/admin/quizzes/${quizId}`}
            className="mt-3 inline-block font-bold text-cyan hover:underline"
          >
            Fix in the editor →
          </Link>
        </Panel>
      )}
      {error && <p className="text-danger">{error}</p>}

      <Button onClick={() => void start()} disabled={busy || !quizId}>
        {busy ? 'Creating…' : 'Start session'}
      </Button>
    </div>
  );
}
