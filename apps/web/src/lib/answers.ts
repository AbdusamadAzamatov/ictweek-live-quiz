/** Answer option identity: shape + letter + colour. Colour is never the only cue. */
export const ANSWER_STYLES = [
  { letter: 'A', shape: '▲', color: '#0084FF', darkText: false },
  { letter: 'B', shape: '◆', color: '#7C3AED', darkText: false },
  { letter: 'C', shape: '●', color: '#00D8FF', darkText: true },
  { letter: 'D', shape: '■', color: '#F59E0B', darkText: true },
  { letter: 'E', shape: '⬟', color: '#EC4899', darkText: false },
  { letter: 'F', shape: '★', color: '#10B981', darkText: false },
] as const;

export function answerStyle(index: number) {
  return ANSWER_STYLES[index % ANSWER_STYLES.length]!;
}
