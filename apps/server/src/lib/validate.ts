import type { ZodType } from 'zod';

/** Parse a request body/params against a Zod schema; failures become 400s. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('Invalid request') as Error & {
      statusCode: number;
      issues: unknown;
    };
    err.statusCode = 400;
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
}
