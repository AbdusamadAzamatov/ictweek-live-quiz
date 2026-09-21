import { answerStyle } from '../lib/answers';

/**
 * Large-touch-target answer card. Shape + letter + colour together carry the
 * option identity, so colour is never the only cue.
 */
export function AnswerCard({
  index,
  label,
  selected = false,
  showText = true,
  disabled = false,
  onSelect,
}: {
  index: number;
  label: string;
  selected?: boolean;
  /** false on player devices when the host keeps text on the big screen. */
  showText?: boolean;
  disabled?: boolean;
  onSelect?: (index: number) => void;
}) {
  const style = answerStyle(index);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.(index)}
      aria-pressed={selected}
      className={`flex min-h-20 w-full items-center gap-4 rounded-2xl p-4 text-left text-xl font-bold transition md:min-h-28 md:text-2xl ${
        selected ? 'ring-4 ring-white brightness-125' : 'hover:brightness-110'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      style={{ backgroundColor: style.color, color: style.darkText ? '#001C5D' : '#FFFFFF' }}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center text-2xl md:h-12 md:w-12 md:text-3xl">
        {style.shape}
      </span>
      <span className="font-black">{style.letter}</span>
      {showText && <span className="min-w-0 flex-1 break-words">{label}</span>}
    </button>
  );
}
