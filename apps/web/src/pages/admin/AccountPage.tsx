import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';
import { useMe } from '../../components/RequireAuth';

export function AccountPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const inputCls =
    'rounded-xl border border-white/15 bg-navy/70 px-4 py-3 text-lg outline-none placeholder:text-white/25 focus:border-cyan';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof (err.data as { error?: string }).error === 'string'
          ? (err.data as { error: string }).error
          : 'Server unreachable',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mx-auto max-w-md">
      <h1 className="mb-1 text-2xl font-black">Account</h1>
      <p className="mb-6 text-white/60">{me.data?.organizer.email}</p>
      {done && (
        <p className="mb-4 rounded-xl border border-emerald-400/40 bg-emerald-400/15 px-4 py-3 text-sm font-semibold text-emerald-200">
          Password changed — other devices were signed out
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-white/60">
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-white/60">
          New password (at least 10 characters)
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-white/60">
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <Button
          type="submit"
          disabled={!currentPassword || newPassword.length < 10 || !confirm || busy}
        >
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </form>
    </Panel>
  );
}
