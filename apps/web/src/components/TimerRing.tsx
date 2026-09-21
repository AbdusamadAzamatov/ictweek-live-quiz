/** Visual-only countdown ring; the game engine wires real time in Phase 2. */
export function TimerRing({
  fraction = 1,
  seconds,
  size = 96,
  danger = false,
}: {
  /** 0..1 remaining */
  fraction?: number;
  seconds?: number;
  size?: number;
  /** Turns the ring + digits danger-red (last seconds). */
  danger?: boolean;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={danger ? 'var(--color-danger)' : 'var(--color-cyan)'}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <span
        className={`absolute text-2xl font-black tabular-nums ${danger ? 'text-danger' : ''}`}
      >
        {seconds ?? ''}
      </span>
    </div>
  );
}
