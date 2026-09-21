import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import QRCode from 'qrcode';
import type { GameSnapshot } from '@ictquiz/shared';
import { useLive, useServerNow } from '../live/store';
import { connectLive, disconnectLive } from '../live/socket';
import { answerStyle } from '../lib/answers';
import { PinDisplay } from '../components/PinDisplay';
import { TimerRing } from '../components/TimerRing';

/** Hide the projector cursor after 3 s idle. */
function useIdleCursor() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      document.body.style.cursor = 'auto';
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.body.style.cursor = 'none';
      }, 3000);
    };
    arm();
    window.addEventListener('mousemove', arm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', arm);
      document.body.style.cursor = 'auto';
    };
  }, []);
}

function Lobby({ snap, lobby }: { snap: GameSnapshot; lobby: { count: number; participants: Array<{ id: string; nickname: string }> } | null }) {
  const names = lobby?.participants ?? [];
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(snap.joinUrl, { margin: 1, width: 240 }).then(
      (url) => live && setQr(url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [snap.joinUrl]);

  return (
    <div className="flex w-full flex-col items-center gap-8">
      <h1 className="text-4xl font-black">{snap.quiz.title}</h1>
      <div className="flex items-center gap-10">
        <div className="text-center">
          <p className="mb-2 text-lg tracking-widest text-white/60 uppercase">
            Join with PIN
          </p>
          <PinDisplay pin={snap.pin} />
          <p className="mt-3 text-cyan">{snap.joinUrl}</p>
        </div>
        {qr && (
          <img src={qr} alt={`QR code for ${snap.joinUrl}`} className="rounded-xl bg-white p-2" />
        )}
      </div>
      <p className="text-2xl font-bold">
        {snap.participantCount} player{snap.participantCount === 1 ? '' : 's'} in the lobby
      </p>
      <div className="flex max-w-5xl flex-wrap justify-center gap-3">
        {names.map((p) => (
          <span key={p.id} className="rounded-full bg-white/10 px-4 py-2 text-xl font-bold">
            {p.nickname}
          </span>
        ))}
      </div>
      {snap.locked && <p className="text-warning">Lobby is locked</p>}
    </div>
  );
}

function QuestionOpen({
  snap,
  progress,
}: {
  snap: GameSnapshot;
  progress: { attemptId: string; answered: number; eligible: number } | null;
}) {
  const serverNow = useServerNow();
  const q = snap.question!;
  const opened = q.openedAt ? Date.parse(q.openedAt) : null;
  const deadline = q.deadlineAt ? Date.parse(q.deadlineAt) : null;
  const total = opened && deadline ? deadline - opened : q.timeLimitSec * 1000;
  const remaining = deadline ? Math.max(0, deadline - serverNow) : total;
  const fraction = total > 0 ? remaining / total : 0;
  const seconds = Math.ceil(remaining / 1000);
  const answered = snap.results?.answered ?? progress?.answered ?? 0;
  const eligible =
    snap.results?.eligible ?? progress?.eligible ?? snap.participantCount;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="flex w-full max-w-6xl items-start justify-between gap-6">
        <h1 className="flex-1 text-4xl font-black">{q.text}</h1>
        <TimerRing fraction={fraction} seconds={seconds} size={110} />
      </div>
      {q.media && (
        <img src={q.media.url} alt={q.media.alt} className="max-h-72 rounded-panel object-contain" />
      )}
      <div
        className={`grid w-full max-w-6xl gap-4 ${q.options.length <= 2 ? 'grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}
      >
        {q.options.map((o) => {
          const st = answerStyle(o.index);
          return (
            <div
              key={o.id}
              className="flex min-h-24 items-center gap-4 rounded-2xl p-5 text-2xl font-bold"
              style={{ backgroundColor: st.color, color: st.darkText ? '#001C5D' : '#fff' }}
            >
              <span className="text-3xl">{st.shape}</span>
              <span className="font-black">{st.letter}</span>
              {o.media && (
                <img
                  src={o.media.url}
                  alt={o.media.alt}
                  className="h-16 w-16 shrink-0 rounded-lg object-cover"
                />
              )}
              <span className="min-w-0 flex-1 break-words">{o.text}</span>
            </div>
          );
        })}
      </div>
      <p className="text-xl text-white/70">
        {answered} / {eligible} answered
      </p>
    </div>
  );
}

function AnswerReveal({ snap }: { snap: GameSnapshot }) {
  const q = snap.question!;
  const results = snap.results;
  const max = Math.max(1, ...(results?.distribution.map((d) => d.count) ?? [1]));
  const correctIds = new Set(results?.correctOptionIds ?? []);

  return (
    <div className="flex w-full max-w-6xl flex-col items-center gap-6">
      <h1 className="text-4xl font-black">{q.text}</h1>
      <div className="flex w-full flex-col gap-3">
        {q.options.map((o) => {
          const st = answerStyle(o.index);
          const count = results?.distribution.find((d) => d.optionId === o.id)?.count ?? 0;
          const correct = correctIds.has(o.id);
          return (
            <div key={o.id} className="flex items-center gap-4">
              <div
                className="flex min-h-16 flex-1 items-center gap-3 rounded-2xl p-4 text-xl font-bold"
                style={{
                  backgroundColor: st.color,
                  color: st.darkText ? '#001C5D' : '#fff',
                  opacity: correct ? 1 : 0.45,
                }}
              >
                <span className="text-2xl">{st.shape}</span>
                <span>{st.letter}</span>
                {o.media && (
                  <img
                    src={o.media.url}
                    alt={o.media.alt}
                    className="h-12 w-12 shrink-0 rounded-lg object-cover"
                  />
                )}
                <span className="min-w-0 flex-1 break-words">{o.text}</span>
                {correct && <span className="text-2xl">✓</span>}
              </div>
              <div className="flex w-64 items-center gap-3">
                <div
                  className="h-8 rounded-r-lg bg-cyan transition-all"
                  style={{ width: `${Math.max(2, (count / max) * 100)}%` }}
                />
                <span className="text-2xl font-black tabular-nums">{count}</span>
              </div>
            </div>
          );
        })}
      </div>
      {q.explanation && <p className="text-xl text-white/70">{q.explanation}</p>}
    </div>
  );
}

function Leaderboard({ snap }: { snap: GameSnapshot }) {
  const rows = snap.leaderboard ?? [];
  const max = Math.max(1, ...rows.map((r) => r.score));
  return (
    <div className="flex w-full max-w-4xl flex-col items-center gap-6">
      <h1 className="text-4xl font-black">Leaderboard</h1>
      <div className="flex w-full flex-col gap-3">
        {rows.map((r) => (
          <div key={r.participantId} className="flex items-center gap-4">
            <span className="w-12 text-right text-3xl font-black text-cyan">#{r.rank}</span>
            <div className="flex-1 overflow-hidden rounded-2xl bg-white/10">
              <div
                className="leaderboard-bar flex items-center justify-between px-5 py-4 text-2xl font-bold"
                style={{ width: `${Math.max(12, (r.score / max) * 100)}%` }}
              >
                <span className="truncate">{r.nickname}</span>
                <span className="tabular-nums">{r.score}</span>
              </div>
            </div>
            <span className="w-12 text-2xl font-black">
              {r.delta > 0 ? (
                <span className="text-success">▲{r.delta}</span>
              ) : r.delta < 0 ? (
                <span className="text-danger">▼{-r.delta}</span>
              ) : (
                <span className="text-white/30">·</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Podium({ snap }: { snap: GameSnapshot }) {
  const top = snap.leaderboard ?? [];
  // Fixed rank→column slots so fewer than 3 players keeps the right blocks.
  const columns = [
    { rank: 3, p: top[2], height: 110, delay: 0 },
    { rank: 1, p: top[0], height: 190, delay: 1.2 },
    { rank: 2, p: top[1], height: 150, delay: 0.6 },
  ];
  return (
    <div className="flex w-full flex-col items-center gap-8">
      <h1 className="text-5xl font-black">Podium</h1>
      <div className="flex items-end gap-6">
        {columns.map(({ rank, p, height, delay }) => (
          <div key={rank} className="flex w-52 flex-col items-center gap-3">
            <p className="podium-name text-2xl font-bold" style={{ animationDelay: `${delay}s` }}>
              {p?.nickname ?? ''}
            </p>
            <p
              className="podium-name text-xl text-cyan tabular-nums"
              style={{ animationDelay: `${delay}s` }}
            >
              {p ? p.score : ''}
            </p>
            <div
              className="podium-block w-full rounded-t-2xl bg-brand"
              style={{ height, animationDelay: `${delay}s`, opacity: p ? 1 : 0.25 }}
            >
              <p className="pt-3 text-center text-4xl font-black">{rank}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DisplayPage() {
  const { displayKey = '' } = useParams();
  const snapshot = useLive((s) => s.snapshot);
  const status = useLive((s) => s.status);
  const lobby = useLive((s) => s.lobby);
  const progress = useLive((s) => s.progress);
  useIdleCursor();

  useEffect(() => {
    connectLive({ role: 'display', displayKey });
    return () => disconnectLive();
  }, [displayKey]);

  const countdownKey = useMemo(
    () => `${snapshot?.state}:${snapshot?.questionIndex}:${snapshot?.revision}`,
    [snapshot?.state, snapshot?.questionIndex, snapshot?.revision],
  );

  let body: React.ReactNode = <p className="text-2xl text-white/60">Connecting…</p>;
  if (snapshot) {
    switch (snapshot.state) {
      case 'LOBBY':
        body = <Lobby snap={snapshot} lobby={lobby} />;
        break;
      case 'COUNTDOWN':
        body = (
          <div className="flex flex-col items-center gap-8">
            {snapshot.question && (
              <h1 className="max-w-5xl text-center text-5xl font-black">
                {snapshot.question.text}
              </h1>
            )}
            <div key={countdownKey} className="countdown-ring">
              <TimerRing fraction={1} size={140} />
            </div>
            <p className="text-3xl font-black text-white/80">Get ready…</p>
          </div>
        );
        break;
      case 'QUESTION_OPEN':
      case 'QUESTION_CLOSED':
        body = <QuestionOpen snap={snapshot} progress={progress} />;
        break;
      case 'ANSWER_REVEAL':
        body = <AnswerReveal snap={snapshot} />;
        break;
      case 'LEADERBOARD':
        body = <Leaderboard snap={snapshot} />;
        break;
      case 'FINISHED':
        body = <Podium snap={snapshot} />;
        break;
      case 'RECOVERY':
        body = <p className="text-3xl font-bold">The host is resuming the game…</p>;
        break;
      case 'CANCELLED':
        body = <p className="text-3xl font-bold">Session ended</p>;
        break;
    }
  }

  return (
    <div className="app-shell flex min-h-screen flex-col items-center justify-center p-8">
      {status === 'reconnecting' && (
        <div className="fixed inset-x-0 top-4 flex justify-center">
          <span className="rounded-full bg-warning px-4 py-1 font-bold text-navy">
            Reconnecting…
          </span>
        </div>
      )}
      {body}
    </div>
  );
}
