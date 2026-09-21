import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Panel } from '../../components/Panel';
import { answerStyle } from '../../lib/answers';

type QuizDetail = {
  id: string;
  title: string;
  description: string;
  questions: Array<{
    id: string;
    type: string;
    text: string;
    timeLimitSec: number;
    pointsMode: string;
    options: Array<{ id: string; text: string; isCorrect: boolean }>;
  }>;
};

export function QuizViewPage() {
  const { id = '' } = useParams();
  const quiz = useQuery({
    queryKey: ['quiz', id],
    queryFn: () => api<{ quiz: QuizDetail }>(`/quizzes/${id}`),
  });

  if (quiz.isLoading) return <p className="text-white/60">Loading…</p>;
  if (quiz.error || !quiz.data) return <p className="text-danger">Quiz not found.</p>;
  const q = quiz.data.quiz;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-black">{q.title}</h1>
        {q.description && <p className="text-white/60">{q.description}</p>}
        <p className="mt-1 text-sm text-white/40">
          Read-only view — the full editor arrives in the next build phase.
        </p>
      </div>
      {q.questions.map((question, i) => (
        <Panel key={question.id}>
          <div className="mb-3 flex items-baseline gap-3">
            <span className="text-white/40">#{i + 1}</span>
            <h2 className="text-xl font-bold">
              {question.text || <em className="text-white/40">(no text)</em>}
            </h2>
            <span className="ml-auto text-sm text-white/50">
              {question.type} · {question.timeLimitSec}s · {question.pointsMode}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {question.options.map((o, oi) => {
              const s = answerStyle(oi);
              return (
                <div
                  key={o.id}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 font-semibold ${
                    o.isCorrect ? 'ring-2 ring-success' : ''
                  }`}
                  style={{ backgroundColor: s.color, color: s.darkText ? '#001C5D' : '#fff' }}
                >
                  <span>{s.shape}</span>
                  <span className="font-black">{s.letter}</span>
                  <span className="min-w-0 flex-1 truncate">{o.text}</span>
                  {o.isCorrect && <span>✓</span>}
                </div>
              );
            })}
          </div>
        </Panel>
      ))}
      {q.questions.length === 0 && (
        <Panel className="text-white/60">This quiz has no questions yet.</Panel>
      )}
    </div>
  );
}
