import { describe, expect, it } from 'vitest';
import {
  csvCell,
  csvQuotedCell,
  csvToQuestionDrafts,
  parseCsv,
  serializeCsv,
  CSV_TEMPLATE,
} from '../src/csv.js';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas and newlines', () => {
    expect(parseCsv('a,"b,1","x\ny"')).toEqual([['a', 'b,1', 'x\ny']]);
  });

  it('handles escaped quotes', () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('handles CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles trailing empty fields and missing newline', () => {
    expect(parseCsv('a,b,\n1,,3')).toEqual([
      ['a', 'b', ''],
      ['1', '', '3'],
    ]);
  });

  it('throws on unclosed quote', () => {
    expect(() => parseCsv('"oops')).toThrow();
  });
});

describe('csvCell', () => {
  it('quotes cells with commas/quotes/newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
  });
  it('prefixes formula-leading cells', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+x')).toBe("'+x");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@x')).toBe("'@x");
  });
  it('leaves plain cells alone', () => {
    expect(csvCell('hello')).toBe('hello');
  });
});

describe('serializeCsv (report serializer)', () => {
  it('quotes every field and escapes embedded quotes', () => {
    expect(serializeCsv([['hello', 'a,b', 'say "x"', 'line\nbreak']])).toBe(
      '"hello","a,b","say ""x""","line\nbreak"\r\n',
    );
  });
  it('prefixes every dangerous leading character', () => {
    for (const ch of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvQuotedCell(`${ch}cmd`)).toBe(`"'${ch}cmd"`);
    }
    expect(csvQuotedCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
  it('quotes numbers without prefixing them', () => {
    expect(serializeCsv([[1, 2.5, 0]])).toBe('"1","2.5","0"\r\n');
  });
  it('round-trips through parseCsv (CRLF handled)', () => {
    const rows = [
      ['Nick,name', 'Q1', 'A; C', '12'],
      ['=SUM(1)', 'x"y', 'line\nbreak', '0'],
    ];
    expect(parseCsv(serializeCsv(rows))).toEqual([
      ['Nick,name', 'Q1', 'A; C', '12'],
      ["'=SUM(1)", 'x"y', 'line\nbreak', '0'],
    ]);
  });
});

describe('csvToQuestionDrafts', () => {
  const header =
    'type,question,option1,option2,option3,option4,option5,option6,correct,timeLimit,points,explanation';

  it('parses a single row', () => {
    const { questions, errors } = csvToQuestionDrafts(
      `${header}\nsingle,What is 2+2?,4,3,,,,,1,20,standard,`,
    );
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      type: 'SINGLE',
      text: 'What is 2+2?',
      timeLimitSec: 20,
      pointsMode: 'STANDARD',
    });
    expect(questions[0]!.options.map((o) => o.isCorrect)).toEqual([true, false]);
  });

  it('parses a truefalse row into fixed True/False options', () => {
    const { questions, errors } = csvToQuestionDrafts(
      `${header}\ntruefalse,Sky is green,,,,,,,2`,
    );
    expect(errors).toEqual([]);
    expect(questions[0]!.type).toBe('TRUE_FALSE');
    expect(questions[0]!.options).toEqual([
      expect.objectContaining({ text: 'True', isCorrect: false }),
      expect.objectContaining({ text: 'False', isCorrect: true }),
    ]);
  });

  it('parses multi correct indexes', () => {
    const { questions, errors } = csvToQuestionDrafts(
      `${header}\nmulti,Pick vowels,A,B,E,Z,,,1;3,30,double,`,
    );
    expect(errors).toEqual([]);
    expect(questions[0]!.options.map((o) => o.isCorrect)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(questions[0]!.pointsMode).toBe('DOUBLE');
  });

  it('reports a bad correct index', () => {
    const { questions, errors } = csvToQuestionDrafts(
      `${header}\nsingle,Q?,a,b,,,,,5`,
    );
    expect(questions).toHaveLength(0);
    expect(errors).toEqual([{ row: 2, message: expect.stringContaining('correct') }]);
  });

  it('reports a bad type and keeps valid rows', () => {
    const { questions, errors } = csvToQuestionDrafts(
      `${header}\nbogus,Q?,a,b,,,,,1\nsingle,Q2?,x,y,,,,,2`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.row).toBe(2);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.text).toBe('Q2?');
  });

  it('reports bad timeLimit and points', () => {
    const { errors } = csvToQuestionDrafts(`${header}\nsingle,Q?,a,b,,,,,1,7`);
    expect(errors[0]!.message).toContain('timeLimit');
    const { errors: e2 } = csvToQuestionDrafts(`${header}\nsingle,Q?,a,b,,,,,1,20,triple`);
    expect(e2[0]!.message).toContain('points');
  });

  it('requires exactly one correct for single and tf', () => {
    const r1 = csvToQuestionDrafts(`${header}\nsingle,Q?,a,b,,,,,1;2`);
    expect(r1.errors[0]!.message).toContain('exactly one');
    const r2 = csvToQuestionDrafts(`${header}\ntruefalse,Q?,,,,,,,3`);
    expect(r2.errors[0]!.message).toContain('1 (True) or 2 (False)');
  });

  it('the template imports cleanly with 3 questions', () => {
    const { questions, errors } = csvToQuestionDrafts(CSV_TEMPLATE);
    expect(errors).toEqual([]);
    expect(questions.map((q) => q.type)).toEqual(['SINGLE', 'TRUE_FALSE', 'MULTI']);
  });
});
