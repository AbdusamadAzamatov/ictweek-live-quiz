import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  EV,
  type GameSnapshot,
  type HostCommandResult,
  type HostCommandType,
} from '@ictquiz/shared';
import { useLive, useServerNow } from '../../live/store';
import { connectLive, disconnectLive, emitAck } from '../../live/socket';
import { answerStyle } from '../../lib/answers';
import { Button } from '../../components/Button';
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

function ConfirmButton({
  label,
  confirm,
  onConfirm,
  variant = 'ghost',
  disabled,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
}) {
  return (
    <Button
      variant={variant}
      disabled={disabled}
      onClick={() => {
        if (window.confirm(confirm)) onConfirm();
      }}
    >
      {label}
    </Button>
  );
}

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

function PlayerList({ snap, command }: Props & { command: ReturnType<typeof useCommand> }) {
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
            onClick={() => {
              if (window.confirm(`Remove ${p.nickname} from the game?`)) {
                void command('REMOVE_PARTICIPANT', p.id);
              }
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function HostPage() {
  const { id = '' } = useParams();
  const snapshot = useLive((s) => s.snapshot);
  const progress = useLive((s) => s.progress);
  const command = useCommand();
  const serverNow = useServerNow(250);
  const [startAnyway, setStartAnyway] = useState(false);

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
        onClick={() => {
          if (snap.participantCount === 0 && !startAnyway) {
            setStartAnyway(true);
            if (window.confirm('No players have joined yet. Start anyway?')) {
              void command('START');
            }
            return;
          }
          void command('START');
        }}
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
          onClick={() => setStartAnyway(true)}
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
      <ConfirmButton
        key="end"
        variant="danger"
        label="End session"
        confirm="End this session for everyone?"
        onConfirm={() => void command('END')}
      />,
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
                <div>
                  <p className="text-xs tracking-widest text-white/50 uppercase">PIN</p>
                  <PinDisplay pin={snap.pin} />
                </div>
                <div className="text-left text-white/70">
                  <p>{snap.participantCount} players</p>
                  <p>{snap.locked ? 'Lobby locked' : 'Lobby open'}</p>
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
                className="text-cyan underline"
              >
                Open report (coming in Phase 4)
              </Link>
            )}
          </Panel>

          <Panel className="flex flex-wrap items-center gap-3">{controls}</Panel>
        </div>

        <Panel className="h-fit">
          <h2 className="mb-3 text-xl font-black">Players ({snap.participantCount})</h2>
          <PlayerList snap={snap} command={command} />
        </Panel>
      </div>
    </div>
  );
}
