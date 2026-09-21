import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TIME_LIMITS,
  type Issue,
  type QuestionDraft,
  type QuestionType,
} from '@ictquiz/shared';
import { api } from '../../lib/api';
import { answerStyle } from '../../lib/answers';
import { randomId } from '../../lib/ids';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';
import { MediaField } from '../../components/MediaField';

// ---------------------------------------------------------------------------
// Draft model — rows are keyed by LOCAL client keys (server ids regenerate on
// every PUT, so they can never key React state).
// ---------------------------------------------------------------------------

type EditorOption = {
  key: string;
  text: string;
  mediaId: string | null;
  mediaUrl?: string;
  mediaAlt?: string;
  isCorrect: boolean;
};

type EditorQuestion = {
  key: string;
  type: QuestionType;
  text: string;
  mediaId: string | null;
  mediaUrl?: string;
  mediaAlt?: string;
  timeLimitSec: number;
  pointsMode: string;
  explanation: string;
  options: EditorOption[];
};

type EditorDraft = {
  title: string;
  description: string;
  coverMediaId: string | null;
  coverUrl?: string;
  questions: EditorQuestion[];
};

type QuizDto = {
  id: string;
  title: string;
  description: string;
  coverMediaId: string | null;
  questions: Array<{
    id: string;
    type: QuestionType;
    text: string;
    mediaId: string | null;
    timeLimitSec: number;
    pointsMode: string;
    explanation: string;
    options: Array<{ id: string; text: string; mediaId: string | null; isCorrect: boolean }>;
  }>;
};

const newKey = () => randomId();

function toDraft(quiz: QuizDto): EditorDraft {
  return {
    title: quiz.title,
    description: quiz.description,
    coverMediaId: quiz.coverMediaId,
    questions: quiz.questions.map((q) => ({
      key: newKey(),
      type: q.type,
      text: q.text,
      mediaId: q.mediaId,
      timeLimitSec: q.timeLimitSec,
      pointsMode: q.pointsMode,
      explanation: q.explanation,
      options: q.options.map((o) => ({
        key: newKey(),
        text: o.text,
        mediaId: o.mediaId,
        isCorrect: o.isCorrect,
      })),
    })),
  };
}

function toPutBody(d: EditorDraft) {
  return {
    title: d.title,
    description: d.description,
    coverMediaId: d.coverMediaId,
    questions: d.questions.map((q) => ({
      type: q.type,
      text: q.text,
      mediaId: q.mediaId,
      timeLimitSec: q.timeLimitSec,
      pointsMode: q.pointsMode,
      explanation: q.explanation,
      options: q.options.map((o) => ({
        text: o.text,
        mediaId: o.mediaId,
        isCorrect: o.isCorrect,
      })),
    })),
  };
}

function newQuestion(type: QuestionType): EditorQuestion {
  const base: EditorQuestion = {
    key: newKey(),
    type,
    text: '',
    mediaId: null,
    timeLimitSec: 20,
    pointsMode: 'STANDARD',
    explanation: '',
    options: [],
  };
  if (type === 'TRUE_FALSE') {
    base.options = [
      { key: newKey(), text: 'True', mediaId: null, isCorrect: true },
      { key: newKey(), text: 'False', mediaId: null, isCorrect: false },
    ];
  } else if (type === 'POLL') {
    base.options = [
      { key: newKey(), text: '', mediaId: null, isCorrect: false },
      { key: newKey(), text: '', mediaId: null, isCorrect: false },
    ];
  } else if (type !== 'CONTENT') {
    base.options = [
      { key: newKey(), text: '', mediaId: null, isCorrect: false },
      { key: newKey(), text: '', mediaId: null, isCorrect: false },
    ];
  }
  return base;
}

const TYPE_LABEL: Record<string, string> = {
  SINGLE: 'Single choice',
  TRUE_FALSE: 'True / False',
  MULTI: 'Multi-select',
  POLL: 'Poll',
  CONTENT: 'Content slide',
};

const inputCls =
  'w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-base outline-none focus:border-cyan';
const labelCls = 'mb-1 block text-xs font-bold uppercase tracking-wide text-white/50';

// ---------------------------------------------------------------------------

export function QuizEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const quizQ = useQuery({
    queryKey: ['quiz', id],
    queryFn: () => api<{ quiz: QuizDto }>(`/quizzes/${id}`),
  });

  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [playIssues, setPlayIssues] = useState<Issue[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [csvOpen, setCsvOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<EditorDraft | null>(null);

  useEffect(() => {
    if (!quizQ.data) return;
    const d = toDraft(quizQ.data.quiz);
    setDraft(d);
    setSelKey((k) => k ?? d.questions[0]?.key ?? null);
  }, [quizQ.data]);

  const doSave = async () => {
    const body = pending.current;
    if (!body) return;
    try {
      const res = await api<{ playIssues: Issue[] }>(`/quizzes/${id}`, {
        method: 'PUT',
        body: toPutBody(body),
      });
      setPlayIssues(res.playIssues ?? []);
      setSaveState('saved');
      void queryClient.invalidateQueries({ queryKey: ['quizzes'] });
    } catch {
      setSaveState('failed');
    }
  };

  const mutate = (fn: (d: EditorDraft) => EditorDraft) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      pending.current = next;
      setSaveState('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void doSave(), 800);
      return next;
    });
  };

  const flushSave = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (pending.current) await doSave();
  };

  const patchQ = (key: string, patch: Partial<EditorQuestion>) =>
    mutate((d) => ({
      ...d,
      questions: d.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)),
    }));

  const patchOption = (qKey: string, oKey: string, patch: Partial<EditorOption>) =>
    mutate((d) => ({
      ...d,
      questions: d.questions.map((q) =>
        q.key === qKey
          ? {
              ...q,
              options: q.options.map((o) => (o.key === oKey ? { ...o, ...patch } : o)),
            }
          : q,
      ),
    }));

  const setCorrect = (qKey: string, oKey: string) =>
    mutate((d) => ({
      ...d,
      questions: d.questions.map((q) => {
        if (q.key !== qKey) return q;
        if (q.type === 'MULTI') {
          return {
            ...q,
            options: q.options.map((o) =>
              o.key === oKey ? { ...o, isCorrect: !o.isCorrect } : o,
            ),
          };
        }
        return { ...q, options: q.options.map((o) => ({ ...o, isCorrect: o.key === oKey })) };
      }),
    }));

  const move = (key: string, dir: -1 | 1) =>
    mutate((d) => {
      const i = d.questions.findIndex((q) => q.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.questions.length) return d;
      const questions = [...d.questions];
      [questions[i], questions[j]] = [questions[j]!, questions[i]!];
      return { ...d, questions };
    });

  const duplicate = (key: string) =>
    mutate((d) => {
      const i = d.questions.findIndex((q) => q.key === key);
      if (i < 0) return d;
      const src = d.questions[i]!;
      const copy: EditorQuestion = {
        ...src,
        key: newKey(),
        options: src.options.map((o) => ({ ...o, key: newKey() })),
      };
      const questions = [...d.questions];
      questions.splice(i + 1, 0, copy);
      return { ...d, questions };
    });

  const remove = (key: string) =>
    mutate((d) => ({ ...d, questions: d.questions.filter((q) => q.key !== key) }));

  const addQuestion = (type: QuestionType) =>
    mutate((d) => {
      const q = newQuestion(type);
      setSelKey(q.key);
      return { ...d, questions: [...d.questions, q] };
    });

  const duplicateQuiz = async () => {
    await flushSave();
    const res = await api<{ quiz: { id: string } }>(`/quizzes/${id}/duplicate`, {
      method: 'POST',
    });
    navigate(`/admin/quizzes/${res.quiz.id}`);
  };

  if (quizQ.isLoading || !draft) return <p className="text-white/60">Loading…</p>;
  if (quizQ.error) return <p className="text-danger">Quiz not found.</p>;

  const sel = draft.questions.find((q) => q.key === selKey) ?? draft.questions[0];
  const globalIssues = playIssues.filter((i) => i.questionIndex === undefined);
  const selIndex = sel ? draft.questions.indexOf(sel) : -1;
  const selIssues = playIssues.filter((i) => i.questionIndex === selIndex);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/admin" className="text-sm text-white/60 hover:text-white">
          ← Library
        </Link>
        <input
          className={`${inputCls} max-w-md text-xl font-black`}
          value={draft.title}
          maxLength={95}
          placeholder="Quiz title"
          onChange={(e) => mutate((d) => ({ ...d, title: e.target.value }))}
        />
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            saveState === 'saved'
              ? 'bg-success/20 text-success'
              : saveState === 'failed'
                ? 'bg-danger/20 text-danger'
                : 'bg-white/10 text-white/60'
          }`}
        >
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'failed'
                ? 'Save failed — retry'
                : 'No changes'}
        </span>
        {saveState === 'failed' && (
          <Button variant="ghost" className="px-3 py-1 text-sm" onClick={() => void doSave()}>
            Retry
          </Button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Link to={`/admin/quizzes/${id}/preview`}>
            <Button variant="ghost" className="px-4 py-2 text-sm">
              Preview
            </Button>
          </Link>
          <Link to={`/admin/sessions/new?quizId=${id}`}>
            <Button variant="primary" className="px-4 py-2 text-sm">
              Host session
            </Button>
          </Link>
          <a href={`/api/quizzes/${id}/export`} download>
            <Button variant="ghost" className="px-4 py-2 text-sm">
              Export JSON
            </Button>
          </a>
          <Button variant="ghost" className="px-4 py-2 text-sm" onClick={() => setCsvOpen(true)}>
            Import CSV
          </Button>
          <Button variant="ghost" className="px-4 py-2 text-sm" onClick={() => void duplicateQuiz()}>
            Duplicate
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <input
          className={`${inputCls} max-w-md text-sm`}
          value={draft.description}
          maxLength={500}
          placeholder="Description (optional)"
          onChange={(e) => mutate((d) => ({ ...d, description: e.target.value }))}
        />
        <div className="w-48">
          <MediaField
            compact
            value={{ mediaId: draft.coverMediaId, url: draft.coverUrl }}
            onChange={(v) =>
              mutate((d) => ({ ...d, coverMediaId: v.mediaId, coverUrl: v.url }))
            }
          />
        </div>
      </div>

      {globalIssues.length > 0 && (
        <Panel className="border border-warning/40 bg-warning/10 text-sm text-warning">
          {globalIssues.map((i) => (
            <p key={i.path}>{i.message}</p>
          ))}
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_260px]">
        {/* Left: question list */}
        <div className="flex flex-col gap-2">
          {draft.questions.map((q, i) => (
            <button
              key={q.key}
              onClick={() => setSelKey(q.key)}
              className={`rounded-xl border p-2 text-left text-sm ${
                sel?.key === q.key ? 'border-cyan bg-white/10' : 'border-white/10 bg-white/5'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-white/40">{i + 1}.</span>
                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold">
                  {q.type === 'TRUE_FALSE' ? 'T/F' : q.type === 'CONTENT' ? 'SLIDE' : q.type}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {q.text || <em className="text-white/40">(empty)</em>}
                </span>
              </div>
              <div className="mt-1 flex gap-1 text-xs">
                <button
                  className="rounded px-1.5 hover:bg-white/15 disabled:opacity-30"
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    move(q.key, -1);
                  }}
                >
                  ▲
                </button>
                <button
                  className="rounded px-1.5 hover:bg-white/15 disabled:opacity-30"
                  disabled={i === draft.questions.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    move(q.key, 1);
                  }}
                >
                  ▼
                </button>
                <button
                  className="rounded px-1.5 hover:bg-white/15"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicate(q.key);
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="rounded px-1.5 text-danger hover:bg-white/15"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(q.key);
                  }}
                >
                  Delete
                </button>
              </div>
            </button>
          ))}
          <div className="flex flex-col gap-1">
            {(['SINGLE', 'TRUE_FALSE', 'MULTI', 'POLL', 'CONTENT'] as const).map((t) => (
              <button
                key={t}
                className="rounded-xl border border-dashed border-white/20 px-3 py-2 text-left text-sm text-white/70 hover:border-cyan hover:text-white"
                onClick={() => addQuestion(t)}
              >
                + {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Center: current question */}
        <Panel className="min-h-96">
          {!sel ? (
            <p className="text-white/50">Add a question to start editing.</p>
          ) : sel.type === 'CONTENT' ? (
            <div className="flex flex-col gap-4">
              <div>
                <label className={labelCls}>
                  Slide title ({sel.text.length}/120)
                </label>
                <input
                  className={inputCls}
                  value={sel.text}
                  maxLength={120}
                  placeholder="Slide title…"
                  onChange={(e) => patchQ(sel.key, { text: e.target.value })}
                />
              </div>
              <MediaField
                value={{ mediaId: sel.mediaId, url: sel.mediaUrl, alt: sel.mediaAlt }}
                onChange={(v) =>
                  patchQ(sel.key, { mediaId: v.mediaId, mediaUrl: v.url, mediaAlt: v.alt })
                }
              />
              <div>
                <label className={labelCls}>
                  Body ({sel.explanation.length}/500)
                </label>
                <textarea
                  className={`${inputCls} min-h-32`}
                  value={sel.explanation}
                  maxLength={500}
                  placeholder="Text shown under the title on the projector…"
                  onChange={(e) => patchQ(sel.key, { explanation: e.target.value })}
                />
              </div>
              <p className="text-sm text-white/50">
                Content slides have no answers — the host advances them manually.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {sel.type === 'POLL' && (
                <p className="self-start rounded-full bg-cyan/20 px-3 py-1 text-xs font-bold text-cyan">
                  Unscored poll — no correct answer, no points, no leaderboard
                </p>
              )}
              <div>
                <label className={labelCls}>
                  Question text ({sel.text.length}/120)
                </label>
                <input
                  className={inputCls}
                  value={sel.text}
                  maxLength={120}
                  placeholder="Ask something…"
                  onChange={(e) => patchQ(sel.key, { text: e.target.value })}
                />
              </div>
              <MediaField
                value={{ mediaId: sel.mediaId, url: sel.mediaUrl, alt: sel.mediaAlt }}
                onChange={(v) =>
                  patchQ(sel.key, { mediaId: v.mediaId, mediaUrl: v.url, mediaAlt: v.alt })
                }
              />
              <div className="flex flex-col gap-2">
                {sel.options.map((o, oi) => {
                  const st = answerStyle(oi);
                  const tf = sel.type === 'TRUE_FALSE';
                  return (
                    <div
                      key={o.key}
                      className="flex items-center gap-2 rounded-xl p-2"
                      style={{ backgroundColor: `${st.color}33` }}
                    >
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg font-black"
                        style={{ backgroundColor: st.color, color: st.darkText ? '#001C5D' : '#fff' }}
                      >
                        {st.shape}
                      </span>
                      <span className="w-5 font-black">{st.letter}</span>
                      {tf ? (
                        <span className="flex-1 font-bold">{o.text}</span>
                      ) : (
                        <input
                          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-sm"
                          value={o.text}
                          maxLength={75}
                          placeholder={`Option ${st.letter}`}
                          onChange={(e) => patchOption(sel.key, o.key, { text: e.target.value })}
                        />
                      )}
                      {!tf && (
                        <MediaField
                          compact
                          value={{ mediaId: o.mediaId, url: o.mediaUrl, alt: o.mediaAlt }}
                          onChange={(v) =>
                            patchOption(sel.key, o.key, {
                              mediaId: v.mediaId,
                              mediaUrl: v.url,
                              mediaAlt: v.alt,
                            })
                          }
                        />
                      )}
                      {sel.type !== 'POLL' && (
                        <button
                          title={o.isCorrect ? 'Correct' : 'Mark correct'}
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-black ${
                            o.isCorrect
                              ? 'border-success bg-success text-navy'
                              : 'border-white/30 text-white/50 hover:border-success'
                          }`}
                          onClick={() => setCorrect(sel.key, o.key)}
                        >
                          {sel.type === 'MULTI' ? (o.isCorrect ? '✓' : '') : o.isCorrect ? '●' : '○'}
                        </button>
                      )}
                      {!tf && sel.options.length > 2 && (
                        <button
                          className="shrink-0 text-white/40 hover:text-danger"
                          onClick={() =>
                            mutate((d) => ({
                              ...d,
                              questions: d.questions.map((q) =>
                                q.key === sel.key
                                  ? { ...q, options: q.options.filter((x) => x.key !== o.key) }
                                  : q,
                              ),
                            }))
                          }
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {sel.type !== 'TRUE_FALSE' && sel.options.length < 6 && (
                <button
                  className="self-start rounded-xl border border-dashed border-white/20 px-4 py-2 text-sm text-white/70 hover:border-cyan hover:text-white"
                  onClick={() =>
                    mutate((d) => ({
                      ...d,
                      questions: d.questions.map((q) =>
                        q.key === sel.key
                          ? {
                              ...q,
                              options: [
                                ...q.options,
                                { key: newKey(), text: '', mediaId: null, isCorrect: false },
                              ],
                            }
                          : q,
                      ),
                    }))
                  }
                >
                  + Add option
                </button>
              )}
            </div>
          )}
        </Panel>

        {/* Right: settings + issues */}
        <Panel className="flex flex-col gap-4">
          {sel && sel.type !== 'CONTENT' && (
            <>
              <div>
                <label className={labelCls}>Time limit</label>
                <select
                  className={inputCls}
                  value={sel.timeLimitSec}
                  onChange={(e) => patchQ(sel.key, { timeLimitSec: Number(e.target.value) })}
                >
                  {TIME_LIMITS.map((t) => (
                    <option key={t} value={t}>
                      {t} seconds
                    </option>
                  ))}
                </select>
              </div>
              {sel.type !== 'POLL' && (
                <div>
                  <label className={labelCls}>Points</label>
                  <select
                    className={inputCls}
                    value={sel.pointsMode}
                    onChange={(e) => patchQ(sel.key, { pointsMode: e.target.value })}
                  >
                    <option value="STANDARD">Standard</option>
                    <option value="DOUBLE">Double</option>
                    <option value="NONE">None</option>
                  </select>
                </div>
              )}
              <div>
                <label className={labelCls}>
                  Explanation ({sel.explanation.length}/500)
                </label>
                <textarea
                  className={`${inputCls} min-h-20`}
                  value={sel.explanation}
                  maxLength={500}
                  placeholder="Shown after the reveal"
                  onChange={(e) => patchQ(sel.key, { explanation: e.target.value })}
                />
              </div>
            </>
          )}
          {selIssues.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="mb-1 font-bold">Play issues</p>
              {selIssues.map((i) => (
                <p key={i.path}>• {i.message}</p>
              ))}
            </div>
          )}
          {playIssues.length === 0 && (
            <p className="text-sm text-success">✓ Quiz is playable</p>
          )}
        </Panel>
      </div>

      {csvOpen && (
        <CsvImportDialog
          quizId={id}
          onClose={() => setCsvOpen(false)}
          onImported={(quiz) => {
            setCsvOpen(false);
            const d = toDraft(quiz);
            pending.current = d;
            setDraft(d);
            void queryClient.invalidateQueries({ queryKey: ['quiz', id] });
            void queryClient.invalidateQueries({ queryKey: ['quizzes'] });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV import dialog
// ---------------------------------------------------------------------------

type Preview = {
  questions: QuestionDraft[];
  errors: Array<{ row: number; message: string }>;
};

function CsvImportDialog({
  quizId,
  onClose,
  onImported,
}: {
  quizId: string;
  onClose: () => void;
  onImported: (quiz: QuizDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = async (f: File) => {
    setBusy(true);
    setError(null);
    setFile(f);
    try {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch(`/api/quizzes/${quizId}/import-csv/preview`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Preview failed');
      setPreview(data as Preview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/quizzes/${quizId}/import-csv`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Import failed');
      onImported(data.quiz as QuizDto);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-navy/80 p-4">
      <Panel className="flex w-full max-w-2xl flex-col gap-4">
        <h2 className="text-2xl font-black">Import questions from CSV</h2>
        <div className="flex items-center gap-3 text-sm">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadPreview(f);
            }}
          />
          <Button variant="ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Choose CSV file'}
          </Button>
          <a href="/api/import-template.csv" download className="text-cyan hover:underline">
            Download template
          </a>
        </div>
        {error && <p className="text-danger">{error}</p>}
        {preview && (
          <>
            <div className="max-h-64 overflow-auto rounded-xl border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white/10 text-left">
                    <th className="p-2">Type</th>
                    <th className="p-2">Question</th>
                    <th className="p-2">Options</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.questions.map((q, i) => (
                    <tr key={i} className="border-t border-white/10">
                      <td className="p-2">{q.type}</td>
                      <td className="p-2">{q.text}</td>
                      <td className="p-2">{q.options.length}</td>
                    </tr>
                  ))}
                  {preview.errors.map((e) => (
                    <tr key={`e${e.row}`} className="border-t border-white/10 text-warning">
                      <td className="p-2" colSpan={3}>
                        Row {e.row}: {e.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => void doImport()}
                disabled={busy || preview.questions.length === 0}
              >
                Import {preview.questions.length} question
                {preview.questions.length === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        )}
        {!preview && (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
