import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { scoreSubmission, type QuestionType } from '@ictquiz/shared';
import { api } from '../../lib/api';
import { AnswerCard } from '../../components/AnswerCard';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';

type QuizDto = {
  id: string;
  title: string;
  questions: Array<{
    id: string;
    type: QuestionType;
    text: string;
    mediaId: string | null;
    timeLimitSec: number;
    pointsMode: 'NONE' | 'STANDARD' | 'DOUBLE';
    explanation: string;
    options: Array<{ id: string; text: string; mediaId: string | null; isCorrect: boolean }>;
  }>;
};

type Stage = { kind: 'question' } | { kind: 'reveal' } | { kind: 'done' };

/**
 * Local participant simulation — runs entirely client-side on the saved draft
 * with the shared scorer; no session is created.
 */
export function QuizPreviewPage() {
  const { id = '' } = useParams();
  const quiz = useQuery({
    queryKey: ['quiz', id],
    queryFn: () => api<{ quiz: QuizDto }>(`/quizzes/${id}`),
  });
  const questions = useMemo(() => quiz.data?.quiz.questions ?? [], [quiz.data]);

  const [qi, setQi] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: 'question' });
  const [selected, setSelected] = useState<string[]>([]);
  const [answered, setAnswered] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ isCorrect: boolean; points: number } | null>(null);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const openedAt = useRef(0);

  const q = questions[qi];

  // Local countdown; deadline ends the question even without an answer.
  useEffect(() => {
    if (!q || stage.kind !== 'question') return;
    openedAt.current = Date.now();
    setTimeLeft(q.timeLimitSec);
    const t = setInterval(() => {
      setTimeLeft(Math.max(0, Math.ceil((openedAt.current + q.timeLimitSec * 1000 - Date.now()) / 1000)));
    }, 250);
    const end = setTimeout(() => setStage({ kind: 'reveal' }), q.timeLimitSec * 1000);
    return () => {
      clearInterval(t);
      clearTimeout(end);
    };
  }, [qi, stage.kind, q]);

  const submit = (ids: string[]) => {
    if (!q || stage.kind !== 'question' || answered) return;
    const rt = Date.now() - openedAt.current;
    const scored = scoreSubmission(
      {
        type: q.type,
        timeLimitSec: q.timeLimitSec,
        pointsMode: q.pointsMode,
        options: q.options,
      },
      ids,
      rt,
    );
    setAnswered(ids);
    setResult(scored);
    setScore((s) => s + scored.points);
    if (scored.isCorrect) setCorrectCount((c) => c + 1);
    setStage({ kind: 'reveal' });
  };

  const next = () => {
    if (qi + 1 >= questions.length) {
      setStage({ kind: 'done' });
      return;
    }
    setQi(qi + 1);
    setSelected([]);
    setAnswered(null);
    setResult(null);
    setStage({ kind: 'question' });
  };

  const restart = () => {
    setQi(0);
    setSelected([]);
    setAnswered(null);
    setResult(null);
    setScore(0);
    setCorrectCount(0);
    setStage({ kind: 'question' });
  };

  if (quiz.isLoading) return <p className="text-white/60">Loading…</p>;
  if (quiz.error || !quiz.data) return <p className="text-danger">Quiz not found.</p>;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <Link to={`/admin/quizzes/${id}`} className="text-sm text-white/60 hover:text-white">
          ← Back to editor
        </Link>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white/70">
          Preview — simulated player, nothing is saved
        </span>
      </div>

      {stage.kind === 'done' ? (
        <Panel className="flex flex-col items-center gap-4 py-10 text-center">
          <h1 className="text-4xl font-black">Preview finished</h1>
          <p className="text-2xl">
            Score <span className="font-black text-cyan">{score}</span> · {correctCount}/
            {questions.length} correct
          </p>
          <Button onClick={restart}>Play again</Button>
        </Panel>
      ) : !q ? (
        <Panel className="text-white/60">This quiz has no questions yet.</Panel>
      ) : stage.kind === 'question' ? (
        <Panel className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">
              Question {qi + 1} of {questions.length} · {q.type}
            </span>
            <span className="text-2xl font-black tabular-nums text-cyan">{timeLeft}s</span>
          </div>
          <h1 className="text-2xl font-black">{q.text}</h1>
          <div
            className={`grid gap-3 ${q.options.length <= 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}
          >
            {q.options.map((o, oi) => (
              <AnswerCard
                key={o.id}
                index={oi}
                label={o.text}
                selected={selected.includes(o.id)}
                onSelect={() => {
                  if (q.type === 'MULTI') {
                    setSelected((prev) =>
                      prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id],
                    );
                  } else {
                    submit([o.id]);
                  }
                }}
              />
            ))}
          </div>
          {q.type === 'MULTI' && (
            <Button disabled={selected.length === 0} onClick={() => submit(selected)}>
              Submit
            </Button>
          )}
        </Panel>
      ) : (
        <Panel className="flex flex-col items-center gap-4 py-8 text-center">
          <h1
            className={`text-4xl font-black ${result?.isCorrect ? 'text-success' : 'text-danger'}`}
          >
            {result ? (result.isCorrect ? 'Correct!' : 'Incorrect') : "Time's up"}
          </h1>
          {result && result.points > 0 && (
            <p className="text-3xl font-black text-cyan">+{result.points}</p>
          )}
          <div className="flex w-full flex-col gap-2">
            {q.options.map((o) => {
              const picked = answered?.includes(o.id);
              return (
                <div
                  key={o.id}
                  className={`flex items-center gap-2 rounded-xl px-4 py-2 text-left font-semibold ${
                    o.isCorrect ? 'bg-success/20 ring-2 ring-success' : 'bg-white/5'
                  } ${picked && !o.isCorrect ? 'ring-2 ring-danger' : ''}`}
                >
                  <span>{o.isCorrect ? '✓' : picked ? '✗' : '·'}</span>
                  <span className="min-w-0 flex-1">{o.text}</span>
                </div>
              );
            })}
          </div>
          {q.explanation && <p className="text-white/70">{q.explanation}</p>}
          <Button onClick={next}>
            {qi + 1 >= questions.length ? 'See summary' : 'Next question'}
          </Button>
        </Panel>
      )}
    </div>
  );
}
