import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useMe } from './RequireAuth';

const EVENT_LOGO_URL = import.meta.env.VITE_EVENT_LOGO_URL as string | undefined;

export function AdminLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/admin/login');
    },
  });

  return (
    <div className="app-shell min-h-screen">
      <header className="flex items-center gap-4 border-b border-white/10 px-6 py-4">
        {EVENT_LOGO_URL ? (
          <img src={EVENT_LOGO_URL} alt="Event logo" className="h-8 w-auto" />
        ) : null}
        <Link to="/admin" className="text-xl font-black">
          ICTWEEK Live Quiz
        </Link>
        <nav className="ml-auto flex items-center gap-4 text-sm text-white/70">
          <Link to="/admin" className="hover:text-white">
            Library
          </Link>
          <Link to="/admin/diagnostics" className="hover:text-white">
            Diagnostics
          </Link>
          <span className="hidden sm:inline">{me.data?.organizer.email}</span>
          <button
            onClick={() => logout.mutate()}
            className="rounded-lg border border-white/15 px-3 py-1.5 hover:bg-white/10"
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
