import type { ReactNode } from 'react';

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-panel border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur ${className}`}
    >
      {children}
    </div>
  );
}
