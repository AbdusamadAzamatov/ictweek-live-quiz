import { TIME_LIMITS } from './quiz.js';
import type { QuestionDraft } from './quiz.js';
import type { PointsMode } from './types.js';

// ---------------------------------------------------------------------------
// RFC-4180 CSV parsing (no dependency). Handles quoted fields, embedded
// commas/newlines, "" escapes, CRLF/LF and an optional UTF-8 BOM.
// ---------------------------------------------------------------------------

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      pushField();
      i += 1;
    } else if (c === '\n') {
      pushRow();
      i += 1;
    } else if (c === '\r') {
      // swallow; the \n (or loop end) closes the row
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) throw new Error('Unclosed quote in CSV');
  // Trailing field/row (file may not end with a newline).
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Quote a cell only when needed; formula-injection prefixing per spec. */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function csvRow(cells: Array<string | number>): string {
  return cells.map((c) => csvCell(String(c))).join(',');
}

// ---------------------------------------------------------------------------
// Question rows → drafts
// ---------------------------------------------------------------------------

export const CSV_HEADER =
  'type,question,option1,option2,option3,option4,option5,option6,correct,timeLimit,points,explanation';

export const CSV_TEMPLATE = `${CSV_HEADER}
single,"What is 2 + 2?",4,3,5,22,,,1,20,standard,"Basic arithmetic"
truefalse,"The sky is green",,,,,,,2,10,none,
multi,"Select the primary colours",Red,Green,Blue,Yellow,,,1;3,30,double,"Pick every correct answer"
`;

export type CsvRowError = { row: number; message: string };
export type CsvImportResult = { questions: QuestionDraft[]; errors: CsvRowError[] };

const TYPE_MAP: Record<string, 'SINGLE' | 'TRUE_FALSE' | 'MULTI'> = {
  single: 'SINGLE',
  truefalse: 'TRUE_FALSE',
  multi: 'MULTI',
};
const POINTS_MAP: Record<string, PointsMode> = {
  none: 'NONE',
  standard: 'STANDARD',
  double: 'DOUBLE',
};

/**
 * Convert CSV text (with header row) into question drafts. Rows with problems
 * are skipped and reported as `{row, message}` (row numbers are 1-based file
 * lines, so the header is row 1 and the first data row is row 2).
 */
export function csvToQuestionDrafts(input: string): CsvImportResult {
  const rows = parseCsv(input);
  const questions: QuestionDraft[] = [];
  const errors: CsvRowError[] = [];
  if (rows.length === 0) return { questions, errors };

  // Drop the header row (first row) and fully-empty rows.
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ''));

  data.forEach((cells, idx) => {
    const rowNo = idx + 2;
    const fail = (message: string) => errors.push({ row: rowNo, message });
    const [
      rawType = '',
      question = '',
      o1 = '',
      o2 = '',
      o3 = '',
      o4 = '',
      o5 = '',
      o6 = '',
      rawCorrect = '',
      rawLimit = '',
      rawPoints = '',
      explanation = '',
    ] = cells.map((c) => c.trim());

    const type = TYPE_MAP[rawType.toLowerCase()];
    if (!type) {
      fail(`unknown type "${rawType}" (expected single|truefalse|multi)`);
      return;
    }
    if (question.length === 0) {
      fail('question text is required');
      return;
    }
    if (question.length > 120) {
      fail('question text must be at most 120 characters');
      return;
    }
    if (explanation.length > 500) {
      fail('explanation must be at most 500 characters');
      return;
    }

    let timeLimitSec = 20;
    if (rawLimit !== '') {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || !(TIME_LIMITS as readonly number[]).includes(n)) {
        fail(`timeLimit must be one of ${TIME_LIMITS.join(', ')}`);
        return;
      }
      timeLimitSec = n;
    }

    const pointsMode = rawPoints === '' ? 'STANDARD' : POINTS_MAP[rawPoints.toLowerCase()];
    if (!pointsMode) {
      fail(`points must be none|standard|double`);
      return;
    }

    const optionTexts = [o1, o2, o3, o4, o5, o6].filter((t) => t !== '');
    const correctIndexes = rawCorrect
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number);

    if (type === 'TRUE_FALSE') {
      const idx = correctIndexes[0];
      if (correctIndexes.length !== 1 || (idx !== 1 && idx !== 2)) {
        fail('truefalse needs exactly one correct index: 1 (True) or 2 (False)');
        return;
      }
      questions.push({
        type,
        text: question,
        mediaId: null,
        timeLimitSec,
        pointsMode,
        explanation,
        options: [
          { text: 'True', mediaId: null, isCorrect: idx === 1 },
          { text: 'False', mediaId: null, isCorrect: idx === 2 },
        ],
      });
      return;
    }

    if (optionTexts.length < 2 || optionTexts.length > 6) {
      fail(`${rawType} needs 2–6 options`);
      return;
    }
    if (optionTexts.some((t) => t.length > 75)) {
      fail('option text must be at most 75 characters');
      return;
    }
    if (
      correctIndexes.length < 1 ||
      correctIndexes.some((n) => !Number.isInteger(n) || n < 1 || n > optionTexts.length)
    ) {
      fail(`correct must be 1-based option indexes (1–${optionTexts.length}) separated by ;`);
      return;
    }
    if (type === 'SINGLE' && correctIndexes.length !== 1) {
      fail('single needs exactly one correct option');
      return;
    }
    const correctSet = new Set(correctIndexes);
    questions.push({
      type,
      text: question,
      mediaId: null,
      timeLimitSec,
      pointsMode,
      explanation,
      options: optionTexts.map((text, i) => ({
        text,
        mediaId: null,
        isCorrect: correctSet.has(i + 1),
      })),
    });
  });

  return { questions, errors };
}
