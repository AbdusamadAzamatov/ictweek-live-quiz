import { useEffect, useRef, useState } from 'react';
import { api, apiUpload, type MediaAssetDto } from '../lib/api';
import { Button } from './Button';

export type MediaValue = { mediaId: string | null; url?: string; alt?: string };

/**
 * Image upload + alt text + remove. Reports changes through onChange with the
 * mediaId the draft should persist plus the transient preview url/alt.
 */
export function MediaField({
  value,
  onChange,
  compact = false,
}: {
  value: MediaValue;
  onChange: (v: MediaValue) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve url/alt for a mediaId loaded from the server without a preview.
  useEffect(() => {
    if (!value.mediaId || value.url !== undefined) return;
    let alive = true;
    api<MediaAssetDto>(`/media/${value.mediaId}`)
      .then((a) => {
        if (alive) onChange({ mediaId: a.id, url: a.url, alt: a.altText });
      })
      .catch(() => {
        if (alive) onChange({ mediaId: value.mediaId, url: '' });
      });
    return () => {
      alive = false;
    };
  }, [value.mediaId]);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const asset = await apiUpload<MediaAssetDto>('/media', file);
      onChange({ mediaId: asset.id, url: asset.url, alt: asset.altText });
    } catch {
      setError('Upload failed (png/jpeg/webp/gif, size limit applies)');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const saveAlt = async (alt: string) => {
    onChange({ ...value, alt });
    if (!value.mediaId) return;
    try {
      await api(`/media/${value.mediaId}`, { method: 'PATCH', body: { altText: alt } });
    } catch {
      // alt stays local; the next save still carries the mediaId
    }
  };

  if (!value.mediaId) {
    return (
      <div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button
          variant="ghost"
          className={compact ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-sm'}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Uploading…' : 'Add image'}
        </Button>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        {value.url ? (
          <img
            src={value.url}
            alt={value.alt ?? ''}
            className={`rounded-lg bg-white/5 object-contain ${compact ? 'max-h-16' : 'max-h-32'}`}
          />
        ) : null}
        <Button
          variant="ghost"
          className="px-3 py-1 text-xs"
          onClick={() => onChange({ mediaId: null })}
        >
          Remove
        </Button>
      </div>
      <input
        type="text"
        value={value.alt ?? ''}
        placeholder="Alt text"
        className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm"
        onChange={(e) => onChange({ ...value, alt: e.target.value })}
        onBlur={(e) => void saveAlt(e.target.value)}
      />
    </div>
  );
}
