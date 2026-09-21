import { useCallback, useEffect, useState } from 'react';
import type { GameSnapshot } from '@ictquiz/shared';

/**
 * WebAudio-only sound cues for the display and host screens. No assets —
 * every cue is a short synthesized tone sequence.
 *
 * Browsers require a user gesture before audio can play: the context is
 * created lazily on the first pointerdown/keypress (see useSounds). The mute
 * preference persists in localStorage['ictquiz.muted'].
 */

const MUTE_KEY = 'ictquiz.muted';

let ctx: AudioContext | null = null;
let unlocked = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // storage may be unavailable; the in-memory toggle still applies this session
  }
  notify();
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  ctx ??= new AudioContext();
  return ctx;
}

/** Create/resume the context — call from a user-gesture handler only. */
export function unlockAudio(): void {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  unlocked = true;
  notify();
}

type Tone = {
  freq: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
};

function tone(t: Tone): void {
  const c = audio();
  if (!c || c.state !== 'running' || isMuted()) return;
  const at = c.currentTime + (t.at ?? 0);
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = t.type ?? 'sine';
  osc.frequency.setValueAtTime(t.freq, at);
  if (t.slideTo) osc.frequency.exponentialRampToValueAtTime(t.slideTo, at + t.dur);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(t.gain ?? 0.16, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + t.dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + t.dur + 0.05);
}

export type CueName = 'tick' | 'open' | 'closed' | 'reveal' | 'leaderboard' | 'podium';

export function playCue(name: CueName): void {
  if (isMuted()) return;
  switch (name) {
    case 'tick':
      tone({ freq: 880, dur: 0.07, type: 'square', gain: 0.07 });
      break;
    case 'open':
      tone({ freq: 523, dur: 0.12 });
      tone({ freq: 784, at: 0.09, dur: 0.22, gain: 0.18 });
      break;
    case 'closed':
      tone({ freq: 160, dur: 0.28, type: 'triangle', gain: 0.3, slideTo: 60 });
      break;
    case 'reveal':
      tone({ freq: 392, dur: 0.14 });
      tone({ freq: 523, at: 0.12, dur: 0.14 });
      tone({ freq: 659, at: 0.24, dur: 0.3, gain: 0.2 });
      break;
    case 'leaderboard':
      tone({ freq: 300, dur: 0.6, type: 'sawtooth', gain: 0.08, slideTo: 900 });
      break;
    case 'podium':
      tone({ freq: 523, dur: 0.24 });
      tone({ freq: 659, at: 0.26, dur: 0.24 });
      tone({ freq: 784, at: 0.52, dur: 0.6, gain: 0.22 });
      break;
  }
}

/**
 * Play cues on snapshot state transitions (display + host only — never wire
 * this on the player screen). Returns the mute state + whether a first
 * gesture is still needed before audio can start.
 */
export function useSounds(snapshot: GameSnapshot | null): {
  muted: boolean;
  /** True while audio is willing but the browser still needs a gesture. */
  needsTap: boolean;
  toggleMute: () => void;
} {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, [rerender]);

  // Autoplay policy: the context may only start inside a user gesture.
  useEffect(() => {
    const on = () => unlockAudio();
    window.addEventListener('pointerdown', on, { once: true });
    window.addEventListener('keydown', on, { once: true });
    return () => {
      window.removeEventListener('pointerdown', on);
      window.removeEventListener('keydown', on);
    };
  }, []);

  // M toggles the persisted mute.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      if (e.key.toLowerCase() === 'm') setMuted(!isMuted());
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const state = snapshot?.state;
  useEffect(() => {
    if (!state) return;
    switch (state) {
      case 'COUNTDOWN': {
        // Ticks for the last 3 s of the fixed 5 s countdown.
        const timers = [2000, 3000, 4000].map((ms) => setTimeout(() => playCue('tick'), ms));
        return () => timers.forEach(clearTimeout);
      }
      case 'QUESTION_OPEN':
        playCue('open');
        break;
      case 'QUESTION_CLOSED':
        playCue('closed');
        break;
      case 'ANSWER_REVEAL':
        playCue('reveal');
        break;
      case 'LEADERBOARD':
        playCue('leaderboard');
        break;
      case 'FINISHED':
        playCue('podium');
        break;
    }
    return undefined;
  }, [state]);

  return {
    muted: isMuted(),
    needsTap: !unlocked && !isMuted(),
    toggleMute: () => setMuted(!isMuted()),
  };
}
