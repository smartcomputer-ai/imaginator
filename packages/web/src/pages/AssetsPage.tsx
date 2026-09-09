import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { assetThumbUrl, assetUrl, type AssetView } from '@imaginator/core';
import { Copy, ImagePlus, Upload } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useAssets, useCommand } from '@/api/queries';
import { ASSET_DRAG_TYPE, useUploadFiles } from '@/api/upload';
import { AddToRowDialog } from '@/components/AddToRowDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn, copyText, formatBytes, relativeTime } from '@/lib/utils';
import { toast } from 'sonner';

type Origin = 'all' | 'upload' | 'generation';

export function AssetsPage() {
  useEvents();
  const [params] = useSearchParams();
  const focus = params.get('focus') ?? undefined;
  const [origin, setOrigin] = useState<Origin>('all');
  const [label, setLabel] = useState('');
  const [debouncedLabel, setDebouncedLabel] = useState('');
  const { data, isLoading, error } = useAssets({ origin: origin === 'all' ? undefined : origin, label: debouncedLabel || undefined, limit: 500 });
  const { upload, uploading } = useUploadFiles();
  const [dragOver, setDragOver] = useState(false);
  const [addTarget, setAddTarget] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedLabel(label.trim()), 200);
    return () => clearTimeout(t);
  }, [label]);

  useEffect(() => {
    if (!focus || !data) return;
    document.getElementById(`asset-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, data]);

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', dragOver && 'bg-accent/40')}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        await upload([...e.dataTransfer.files]);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <h1 className="text-sm font-semibold">Assets</h1>
        <span className="text-xs text-muted-foreground">{data ? `${data.assets.length}${data.total > data.assets.length ? ` of ${data.total}` : ''}` : ''}</span>
        <Select value={origin} onValueChange={(v) => setOrigin(v as Origin)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All origins</SelectItem>
            <SelectItem value="upload">Uploads</SelectItem>
            <SelectItem value="generation">Generated</SelectItem>
          </SelectContent>
        </Select>
        <Input className="w-56" placeholder="Filter by label…" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Drop images anywhere to upload</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = e.target.files ? [...e.target.files] : [];
              e.target.value = '';
              await upload(files);
            }}
          />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Spinner className="text-current" /> : <Upload />} Upload
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> Loading…
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {data && data.assets.length === 0 && (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No assets match. Upload images or generate some.</div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {data?.assets.map((a) => (
            <AssetCard key={a.id} asset={a} focused={a.id === focus} onAddToRow={() => setAddTarget(a.id)} />
          ))}
        </div>
      </div>

      <AddToRowDialog assetId={addTarget} open={!!addTarget} onOpenChange={(o) => !o && setAddTarget(undefined)} />
    </div>
  );
}

function AssetCard({ asset, focused, onAddToRow }: { asset: AssetView; focused: boolean; onAddToRow: () => void }) {
  const relabel = useCommand('assets.label');
  const [draft, setDraft] = useState(asset.label ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(asset.label ?? '');
  }, [asset.label, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (asset.label ?? '')) return;
    relabel.mutate({ asset: asset.id, label: next || null });
  };

  return (
    <div
      id={`asset-${asset.id}`}
      className={cn('group flex flex-col overflow-hidden rounded-md border bg-card', focused && 'ring-2 ring-ring')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        e.dataTransfer.setData('text/plain', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <a href={asset.url || assetUrl(asset.id)} target="_blank" rel="noreferrer" className="relative block aspect-square bg-muted">
        <img src={asset.thumbUrl || assetThumbUrl(asset.id)} alt={asset.label ?? asset.id} className="size-full object-cover" loading="lazy" draggable={false} />
        <Badge variant={asset.origin.type === 'upload' ? 'blue' : 'violet'} className="absolute left-1 top-1">
          {asset.origin.type === 'upload' ? 'upload' : 'generated'}
        </Badge>
      </a>
      <div className="flex flex-col gap-1 p-1.5">
        <Input
          className="h-6 px-1 text-xs"
          placeholder="label…"
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(asset.label ?? '');
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
        />
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground cursor-pointer"
            title="Copy id"
            onClick={async () => {
              await copyText(asset.id);
              toast.success(`Copied ${asset.id}`);
            }}
          >
            {asset.id} <Copy className="size-3" />
          </button>
          <span className="ml-auto" title={`${asset.mime} · ${formatBytes(asset.bytes)} · ${asset.createdAt}`}>
            {asset.width}×{asset.height} · {relativeTime(asset.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <WithTooltip label="Append this asset to a row's inputs">
            <Button variant="outline" size="xs" onClick={onAddToRow}>
              <ImagePlus /> Add to row…
            </Button>
          </WithTooltip>
          {asset.origin.type === 'generation' && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground" title="source generation">
              gen {asset.origin.generation}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
