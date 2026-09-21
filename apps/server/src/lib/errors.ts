export type RecentError = { at: string; message: string };

const MAX = 50;
const buffer: RecentError[] = [];

export function recordError(err: unknown): void {
  buffer.push({
    at: new Date().toISOString(),
    message: err instanceof Error ? err.message : String(err),
  });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

export function recentErrors(): RecentError[] {
  return [...buffer];
}
