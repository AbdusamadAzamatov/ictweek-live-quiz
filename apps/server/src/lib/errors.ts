export type ErrorSource = 'http' | 'engine' | 'socket';
export type RecentError = { at: string; source: ErrorSource; message: string };

const MAX = 50;
const buffer: RecentError[] = [];

export function recordError(err: unknown, source: ErrorSource = 'http'): void {
  buffer.push({
    at: new Date().toISOString(),
    source,
    message: err instanceof Error ? err.message : String(err),
  });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

export function recentErrors(): RecentError[] {
  return [...buffer];
}
