import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { EV, type PlayerAnswerResult } from '@ictquiz/shared';
import { useLive } from '../live/store';
import {
  clearStoredPlayer,
  connectLive,
  disconnectLive,
  emitAck,
  loadStoredPlayer,
} from '../live/socket';
import { AnswerCard } from '../components/AnswerCard';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';

function StatusBanner() {
  const status = useLive((s) => s.status);
  if (status !== 'reconnecting' && status !== 'connecting') return null;
  return (
    <div className="fixed inset-x-0 top-3 z-10 flex justify-center">
      <span className="rounded-full bg-warning px-4 py-1 text-sm font-bold text-navy">
        {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </span>
    </div>
  );
}

export function PlayPage() {
  const navigate = useNavigate();
  const snapshot = useLive((s) => s.snapshot);
  const removed = useLive((s) => s.removed);
  const error = useLive((s) => s.error);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [answerError, setAnswerError] = useState<string | null>(null);
  // Bridges the gap between the ack and the resynced me.submission snapshot.
  const [submittedFor, setSubmittedFor] = useState<{
    attemptId: string;
    optionIds: string[];
  } | null>(null);

  const creds = loadStoredPlayer();

  useEffect(() => {
    if (!creds) {
      navigate('/', { replace: true });
      return;
    }
    connectLive({
      role: 'player',
      participantId: creds.participantId,
      resumeToken: creds.resumeToken,
    });
    return () => disconnectLive();
  }, []);

  useEffect(() => {
    if (error === 'UNAUTHORIZED') {
      clearStoredPlayer();
      navigate('/', { replace: true });
    }
  }, [error, navigate]);

  const attemptId = snapshot?.question?.attemptId;
  useEffect(() => {
    setSelected([]);
    setAnswerError(null);
    setPending(false);
    setSubmittedFor(null);
  }, [attemptId]);

  const submit = async (optionIds: string[]) => {
    if (!attemptId || pending) return;
    setPending(true);
    setAnswerError(null);
    try {
      const res = await emitAck<PlayerAnswerResult>(EV.PlayerAnswer, {
        attemptId,
        submissionId: crypto.randomUUID(),
        optionIds,
      });
      if (res.status === 'accepted' || res.status === 'duplicate') {
        setSubmittedFor({ attemptId, optionIds });
      }
      if (res.status === 'rejected') {
        setAnswerError(
          res.reason === 'CLOSED' || res.reason === 'LATE'
            ? "Time's up"
            : res.reason === 'NOT_ELIGIBLE'
              ? "You'll join at the next question"
              : 'Answer was not accepted',
        );
      }
    } catch {
      setAnswerError('Could not reach the server — retrying when reconnected.');
    } finally {
      setPending(false);
    }
  };

  if (!creds) return null;

  if (removed) {
    return (
      <div className="app-shell flex items-center justify-center p-4">
        <Panel className="w-full max-w-md text-center">
          <h1 className="mb-4 text-2xl font-black">You were removed from this game</h1>
          <Link to="/">
            <Button>Join another game</Button>
          </Link>
        </Panel>
      </div>
    );
  }

  const state = snapshot?.state;
  const me = snapshot?.me;
  const question = snapshot?.question;
  const showText = question?.showTextOnPlayer ?? false;
  const submitted = !!me?.submission || submittedFor?.attemptId === attemptId;

  let body: React.ReactNode;
  if (!snapshot) {
    body = <p className="text-white/60">Connecting…</p>;
  } else {
    switch (state) {
      case 'LOBBY':
        body = (
          <>
            <h1 className="mb-2 text-4xl font-black">You're in!</h1>
            <p className="text-xl text-white/70">See your name on the big screen.</p>
            <p className="mt-6 text-3xl font-black text-cyan">{me?.nickname}</p>
          </>
        );
        break;
      case 'COUNTDOWN':
        body = (
          <>
            <h1 className="mb-2 text-4xl font-black">Get ready…</h1>
            {showText && question && (
              <p className="text-xl text-white/80">{question.text}</p>
            )}
          </>
        );
        break;
      case 'QUESTION_OPEN':
        if (submitted) {
          const chosenIds = me?.submission?.optionIds ?? submittedFor?.optionIds ?? [];
          const chosen = question?.options.filter((o) => chosenIds.includes(o.id)) ?? [];
          body = (
            <div className="flex w-full flex-col items-center gap-4">
              <h1 className="mb-2 text-3xl font-black">Answer sent</h1>
              <p className="text-white/70">Waiting for the other players…</p>
              {chosen.length > 0 && (
                <div
                  className={`grid w-full gap-3 ${chosen.length <= 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}
                >
                  {chosen.map((o) => (
                    <AnswerCard
                      key={o.id}
                      index={o.index}
                      label={o.text}
                      media={o.media}
                      showText={showText}
                      selected
                      disabled
                    />
                  ))}
                </div>
              )}
            </div>
          );
        } else if (!me?.canAnswer) {
          body = (
            <>
              <h1 className="mb-2 text-3xl font-black">Hold tight</h1>
              <p className="text-white/70">You'll join at the next question.</p>
            </>
          );
        } else if (question) {
          body = (
            <div className="flex w-full flex-col gap-4">
              {showText && (
                <h2 className="mb-2 text-2xl font-black">{question.text}</h2>
              )}
              {question.media && (
                <img
                  src={question.media.url}
                  alt={question.media.alt}
                  className="max-h-48 w-full rounded-2xl object-contain"
                />
              )}
              <div
                className={`grid gap-3 ${question.options.length <= 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}
              >
                {question.options.map((o) => (
                  <AnswerCard
                    key={o.id}
                    index={o.index}
                    label={o.text}
                    media={o.media}
                    showText={showText}
                    selected={selected.includes(o.id)}
                    disabled={pending}
                    onSelect={() => {
                      if (question.type === 'MULTI') {
                        setSelected((prev) =>
                          prev.includes(o.id)
                            ? prev.filter((id) => id !== o.id)
                            : [...prev, o.id],
                        );
                      } else {
                        void submit([o.id]);
                      }
                    }}
                  />
                ))}
              </div>
              {question.type === 'MULTI' && (
                <Button
                  disabled={selected.length === 0 || pending}
                  onClick={() => void submit(selected)}
                >
                  Submit {selected.length > 0 ? `${selected.length} answer${selected.length > 1 ? 's' : ''}` : ''}
                </Button>
              )}
              {pending && <p className="text-white/70">Sending…</p>}
              {answerError && <p className="text-warning">{answerError}</p>}
            </div>
          );
        }
        break;
      case 'QUESTION_CLOSED':
        body = <h1 className="text-3xl font-black">Time's up</h1>;
        break;
      case 'ANSWER_REVEAL': {
        const r = me?.lastResult;
        body = (
          <>
            <h1
              className={`mb-2 text-4xl font-black ${r?.correct ? 'text-success' : 'text-danger'}`}
            >
              {r ? (r.correct ? 'Correct!' : 'Incorrect') : 'No answer'}
            </h1>
            {r && r.points > 0 && (
              <p className="text-3xl font-black text-cyan">+{r.points}</p>
            )}
            {r && r.streak > 1 && <p className="mt-1 text-white/70">Streak ×{r.streak}</p>}
            {question?.explanation && (
              <p className="mt-4 text-white/70">{question.explanation}</p>
            )}
          </>
        );
        break;
      }
      case 'LEADERBOARD': {
        const delta = snapshot.leaderboard?.find(
          (l) => l.participantId === me?.participantId,
        )?.delta;
        body = (
          <>
            <h1 className="mb-2 text-4xl font-black">You're #{me?.rank ?? '—'}</h1>
            <p className="text-3xl font-black text-cyan">{me?.score ?? 0} pts</p>
            {typeof delta === 'number' && delta !== 0 && (
              <p className={delta > 0 ? 'text-success' : 'text-danger'}>
                {delta > 0 ? `▲ ${delta}` : `▼ ${-delta}`}
              </p>
            )}
          </>
        );
        break;
      }
      case 'FINISHED':
        body = (
          <>
            <h1 className="mb-2 text-4xl font-black">Game over</h1>
            <p className="text-2xl">
              Final rank <span className="font-black text-cyan">#{me?.rank ?? '—'}</span> ·{' '}
              {me?.score ?? 0} pts
            </p>
            <div className="mt-6 text-left">
              {snapshot.leaderboard?.map((l) => (
                <p key={l.participantId} className="text-lg text-white/80">
                  #{l.rank} {l.nickname} — {l.score}
                </p>
              ))}
            </div>
          </>
        );
        break;
      case 'RECOVERY':
        body = (
          <>
            <h1 className="mb-2 text-3xl font-black">Please wait</h1>
            <p className="text-white/70">The host is resuming the game…</p>
          </>
        );
        break;
      case 'CANCELLED':
        body = <h1 className="text-3xl font-black">Session ended</h1>;
        break;
      default:
        body = null;
    }
  }

  return (
    <div className="app-shell flex min-h-screen flex-col items-center justify-center p-4">
      <StatusBanner />
      <div className="flex w-full max-w-2xl flex-col items-center text-center">{body}</div>
    </div>
  );
}
