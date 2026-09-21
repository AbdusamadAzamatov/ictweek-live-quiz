import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export type Me = { organizer: { id: string; email: string; createdAt: string } };

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) {
    return <div className="app-shell flex items-center justify-center text-white/60">Loading…</div>;
  }
  if (me.error) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}
