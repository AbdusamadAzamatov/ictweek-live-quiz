import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import QRCode from 'qrcode';
import {
  EV,
  type GameSnapshot,
  type HostCommandResult,
  type HostCommandType,
} from '@ictquiz/shared';
import { useLive, useServerNow } from '../../live/store';
import { connectLive, disconnectLive, emitAck } from '../../live/socket';
import { answerStyle } from '../../lib/answers';
import { useSounds } from '../../lib/sound';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Panel } from '../../components/Panel';
import { PinDisplay } from '../../components/PinDisplay';
import { TimerRing } from '../../components/TimerRing';

type Props = { snap: GameSnapshot };

function useCommand(): (type: HostCommandType, participantId?: string) => Promise<HostCommandResult | null> {
  return useCallback(async (type, participantId) => {
    try {
      return await emitAck<HostCommandResult>(EV.HostCommand, {
        commandId: crypto.randomUUID(),
        type,
        payload: participantId ? { participantId } : undefined,
      });
    } catch {
      return null;
    }
  }, []);
}

type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  run: () => void;
};

function StatusPill() {
  const status = useLive((s) => s.status);
  const tone =
    status === 'connected'
      ? 'bg-success text-navy'
      : status === 'reconnecting'
        ? 'bg-warning text-navy'
        : 'bg-white/20';
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-bold ${tone}`}>{status}</span>
  );
}

function PlayerList({
  snap,
  onRemove,
}: Props & { onRemove: (p: { id: string; nickname: string }) => void }) {
  const players = snap.host?.participants ?? [];
  if (players.length === 0) return <p className="text-white/50">No players yet.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {players.map((p) => (
        <li
          key={p.id}
          className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2 text-left"
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${p.connected ? 'bg-success' : 'bg-white/30'}`}
            title={p.connected ? 'connected' : 'disconnected'}
          />
          <span className="min-w-0 flex-1 truncate font-bold">{p.nickname}</span>
          <span className="text-sm text-white/60 tabular-nums">{p.score}</span>
          <button
            type="button"
            aria-label={`Remove ${p.nickname}`}
            className="rounded-lg px-2 text-white/50 hover:bg-white/10 hover:text-danger"
            onClick={() => onRemove(p)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function HostQr({ url }: { url: string }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 120 }).then(
      (u) => live && setQr(u),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [url]);
  if (!qr) return null;
  return <img src={qr} alt="QR code to join" className="h-24 w-24 rounded-lg bg-white p-1" />;
}

export function HostPage() {
  const { id = '' } = useParams();
  const snapshot = useLive((s) => s.snapshot);
  const progress = useLive((s) => s.progress);
  const command = useCommand();
  const serverNow = useServerNow(250);
  const { muted, toggleMute } = useSounds(snapshot);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [startAnyway, setStartAnyway] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    connectLive({ role: 'host', sessionId: id });
    return () => disconnectLive();
  }, [id]);

  const primary = useCallback(() => {
    const state = snapshot?.state;
    if (state === 'LOBBY') return void command('START');
    if (state === 'ANSWER_REVEAL' || state === 'LEADERBOARD') return void command('NEXT');
    if (state === 'RECOVERY') return void command('REPLAY_QUESTION');
  }, [snapshot?.state, command]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      const state = snapshot?.state;
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key.toLowerCase() === 'n') {
        e.preventDefault();
        primary();
      } else if (e.key.toLowerCase() === 'c') {
        if (state === 'QUESTION_OPEN') void command('CLOSE_ANSWERS');
      } else if (e.key.toLowerCase() === 'l') {
        if (state === 'LOBBY') void command(snapshot?.locked ? 'UNLOCK_LOBBY' : 'LOCK_LOBBY');
      } else if (e.key.toLowerCase() === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      } else if (e.key === '?') {
        setShowHelp((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot?.state, snapshot?.locked, command, primary]);

  if (!snapshot) {
    return <p className="text-white/60">Connecting to the session…</p>;
  }

  const snap = snapshot;
  const q = snap.question;
  const isLastQuestion =
    snap.questionIndex !== null && snap.questionIndex >= snap.quiz.questionCount - 1;
  const deadline = q?.deadlineAt ? Date.parse(q.deadlineAt) : null;
  const opened = q?.openedAt ? Date.parse(q.openedAt) : null;
  const total = opened && deadline ? deadline - opened : 1;
  const remaining = deadline ? Math.max(0, deadline - serverNow) : 0;
  const answered = progress?.answered ?? snap.host?.answered ?? 0;
  const eligible = progress?.eligible ?? snap.host?.eligible ?? snap.participantCount;
  const running = snap.state !== 'FINISHED' && snap.state !== 'CANCELLED';

  const controls: React.ReactNode[] = [];
  if (snap.state === 'LOBBY') {
    controls.push(
      <Button
        key="start"
        onClick={() => void command('START')}
        disabled={snap.participantCount === 0 && !startAnyway}
      >
        Start game
      </Button>,
    );
    if (snap.participantCount === 0) {
      controls.push(
        <button
          key="anyway"
          className="text-sm text-white/50 underline"
          onClick={() =>
            setConfirm({
              title: 'No players have joined yet',
              body: 'Start the game anyway?',
              confirmLabel: 'Start anyway',
              run: () => {
                setStartAnyway(true);
                void command('START');
              },
            })
          }
        >
          start anyway
        </button>,
      );
    }
    controls.push(
      <Button
        key="lock"
        variant="ghost"
        onClick={() => void command(snap.locked ? 'UNLOCK_LOBBY' : 'LOCK_LOBBY')}
      >
        {snap.locked ? 'Unlock lobby' : 'Lock lobby'}
      </Button>,
    );
  }
  if (snap.state === 'QUESTION_OPEN') {
    controls.push(
      <Button key="close" onClick={() => void command('CLOSE_ANSWERS')}>
        Close answers
      </Button>,
    );
  }
  if (snap.state === 'ANSWER_REVEAL' || snap.state === 'LEADERBOARD') {
    controls.push(
      <Button key="next" onClick={() => void command('NEXT')}>
        {snap.state === 'ANSWER_REVEAL' && isLastQuestion ? 'Show podium' : 'Next'}
      </Button>,
    );
  }
  if (snap.state === 'RECOVERY') {
    controls.push(
      <Button key="replay" onClick={() => void command('REPLAY_QUESTION')}>
        Replay question
      </Button>,
    );
  }
  if (running) {
    controls.push(
      <Button
        key="end"
        variant="danger"
        onClick={() =>
          setConfirm({
            title: 'End session',
            body: 'End this session for everyone?',
            confirmLabel: 'End session',
            danger: true,
            run: () => void command('END'),
          })
        }
      >
        End session
      </Button>,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black">{snap.quiz.title || 'Live session'}</h1>
          <p className="text-white/60">
            State <span className="font-bold text-white">{snap.state}</span> · rev{' '}
            {snap.revision}
            {snap.questionIndex !== null &&
              ` · Q${snap.questionIndex + 1}/${snap.quiz.questionCount}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" className="px-3 py-1 text-sm" onClick={toggleMute}>
            {muted ? '🔇 Sound off' : '🔊 Sound on'}
          </Button>
          <button
            className="rounded-lg border border-white/20 px-2 py-1 text-sm text-white/60 hover:text-white"
            title="Keyboard shortcuts"
            onClick={() => setShowHelp((v) => !v)}
          >
            ?
          </button>
          <StatusPill />
          <a
            href={`/display/${snap.host?.displayKey ?? ''}`}
            target="_blank"
            rel="noreferrer"
            className="text-cyan underline"
          >
            Open projector view
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <Panel className="flex flex-col items-center gap-4 text-center">
            {(snap.state === 'LOBBY' || running) && (
              <div className="flex items-center gap-6">
                <div className="min-w-0 flex-1">
                  <p className="text-xs tracking-widest text-white/50 uppercase">PIN</p>
                  <PinDisplay pin={snap.pin} />
                </div>
                <HostQr url={snap.joinUrl} />
                <div className="w-40 shrink-0 text-left text-white/70">
                  <p>{snap.participantCount} players</p>
                  <p>{snap.locked ? 'Lobby locked' : 'Lobby open'}</p>
                  <button
                    className="mt-1 text-sm text-cyan underline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(snap.joinUrl).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      });
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy join link'}
                  </button>
                </div>
              </div>
            )}
            {(snap.state === 'COUNTDOWN' || snap.state === 'RECOVERY') && (
              <h2 className="text-2xl font-black">
                {snap.state === 'RECOVERY'
                  ? 'Interrupted — replay or end'
                  : `Get ready: ${q?.text ?? ''}`}
              </h2>
            )}
            {(snap.state === 'QUESTION_OPEN' || snap.state === 'QUESTION_CLOSED') && q && (
              <div className="w-full text-left">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <h2 className="text-2xl font-black">{q.text}</h2>
                  <TimerRing
                    fraction={total > 0 ? remaining / total : 0}
                    seconds={Math.ceil(remaining / 1000)}
                    size={72}
                  />
                </div>
                {q.media && (
                  <img
                    src={q.media.url}
                    alt={q.media.alt}
                    className="mb-3 max-h-40 rounded-xl object-contain"
                  />
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {q.options.map((o) => {
                    const st = answerStyle(o.index);
                    return (
                      <div
                        key={o.id}
                        className="flex items-center gap-2 rounded-xl px-3 py-2 text-lg font-bold"
                        style={{
                          backgroundColor: st.color,
                          color: st.darkText ? '#001C5D' : '#fff',
                          opacity: o.isCorrect === false ? 0.7 : 1,
                        }}
                      >
                        <span>{st.shape}</span>
                        <span>{st.letter}</span>
                        {o.media && (
                          <img
                            src={o.media.url}
                            alt={o.media.alt}
                            className="h-9 w-9 shrink-0 rounded-lg object-cover"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{o.text}</span>
                        {o.isCorrect && <span>✓</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 text-white/70">
                  {answered} / {eligible} answered
                </p>
              </div>
            )}
            {snap.state === 'ANSWER_REVEAL' && (
              <div className="w-full text-left">
                <h2 className="mb-3 text-2xl font-black">Answer reveal</h2>
                {snap.results?.distribution.map((d) => {
                  const o = q?.options.find((x) => x.id === d.optionId);
                  const correct = snap.results?.correctOptionIds.includes(d.optionId);
                  return (
                    <p key={d.optionId} className="text-white/80">
                      {correct ? '✓' : '·'} {o?.text ?? d.optionId}:{' '}
                      <span className="font-bold">{d.count}</span>
                    </p>
                  );
                })}
              </div>
            )}
            {(snap.state === 'LEADERBOARD' || snap.state === 'FINISHED') && (
              <div className="w-full text-left">
                <h2 className="mb-3 text-2xl font-black">
                  {snap.state === 'FINISHED' ? 'Podium' : 'Leaderboard'}
                </h2>
                {(snap.leaderboard ?? []).map((l) => (
                  <p key={l.participantId} className="text-lg">
                    <span className="font-black text-cyan">#{l.rank}</span> {l.nickname} —{' '}
                    {l.score}
                    {l.delta !== 0 && (
                      <span className={l.delta > 0 ? 'text-success' : 'text-danger'}>
                        {' '}
                        {l.delta > 0 ? `▲${l.delta}` : `▼${-l.delta}`}
                      </span>
                    )}
                  </p>
                ))}
              </div>
            )}
            {snap.state === 'CANCELLED' && <h2 className="text-2xl font-black">Cancelled</h2>}
            {snap.state === 'FINISHED' && (
              <Link
                to={`/admin/sessions/${snap.sessionId}/report`}
                className="font-bold text-cyan underline"
              >
                Open report →
              </Link>
            )}
          </Panel>

          <Panel className="flex flex-wrap items-center gap-3">{controls}</Panel>
        </div>

        <Panel className="h-fit">
          <h2 className="mb-3 text-xl font-black">Players ({snap.participantCount})</h2>
          <PlayerList
            snap={snap}
            onRemove={(p) =>
              setConfirm({
                title: `Remove ${p.nickname}?`,
                body: 'They will be disconnected and cannot rejoin with the same device session.',
                confirmLabel: 'Remove',
                danger: true,
                run: () => void command('REMOVE_PARTICIPANT', p.id),
              })
            }
          />
        </Panel>
      </div>

      {showHelp && (
        <Panel className="fixed bottom-4 right-4 z-40 w-72 text-sm">
          <p className="mb-2 font-black">Keyboard shortcuts</p>
          <ul className="flex flex-col gap-1 text-white/70">
            <li><b>Space / → / N</b> — primary action (start / next / replay)</li>
            <li><b>C</b> — close answers</li>
            <li><b>L</b> — lock / unlock lobby</li>
            <li><b>M</b> — sound on / off</li>
            <li><b>F</b> — fullscreen</li>
            <li><b>?</b> — this panel</li>
          </ul>
        </Panel>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
      />
    </div>
  );
}
