import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { slugify, type CollectionStatus } from '@imaginator/core';
import { Plus, Trash2, Upload } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useApi, useCollections, useCommand } from '@/api/queries';
import { ProgressBadge } from '@/components/ProgressBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { WithTooltip } from '@/components/ui/tooltip';
import { relativeTime } from '@/lib/utils';
import { toast } from 'sonner';

export function CollectionsPage() {
  useEvents();
  const navigate = useNavigate();
  const api = useApi();
  const { data, isLoading, error } = useCollections();
  const [createOpen, setCreateOpen] = useState(false);
  const remove = useCommand('collections.delete');
  const importRef = useRef<HTMLInputElement>(null);
  const location = useLocation();

  // Selection, kept in the fragment (`/#moonbase`) so a grid's Escape lands back on its row.
  const slugs = useMemo(() => (data?.collections ?? []).map((c) => c.slug), [data]);
  const selected = useMemo(() => {
    const s = decodeURIComponent(location.hash.replace(/^#/, ''));
    return slugs.includes(s) ? s : undefined;
  }, [location.hash, slugs]);
  const select = (slug: string | undefined) => navigate({ hash: slug ? `#${slug}` : '' }, { replace: true });

  useEffect(() => {
    if (selected) document.getElementById(`collection-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return;
      if (slugs.length === 0) return;
      if (e.key === 'Escape' && selected) {
        e.preventDefault();
        select(undefined);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      if (!selected) {
        select(slugs[0]);
        return;
      }
      const i = slugs.indexOf(selected);
      if (e.key === 'ArrowDown') select(slugs[Math.min(slugs.length - 1, i + 1)]);
      else if (e.key === 'ArrowUp') select(slugs[Math.max(0, i - 1)]);
      else navigate(`/c/${selected}`);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, slugs, navigate]);

  const onImport = async (file: File) => {
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      toast.error('Not a JSON file');
      return;
    }
    // Server validates the document; we only pass it through.
    const view = await api('collections.import', { document: document as never });
    toast.success(`Imported ${view.slug}`);
    navigate(`/c/${view.slug}`);
  };

  const collections = data?.collections ?? [];

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-base font-semibold">Collections</h1>
        <span className="text-xs text-muted-foreground">{collections.length ? `${collections.length}` : ''}</span>
        <div className="ml-auto flex gap-2">
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onImport(f);
            }}
          />
          <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
            <Upload /> Import
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> New collection
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Spinner /> Loading…
        </div>
      )}
      {error && <p className="py-4 text-sm text-destructive">Failed to load collections: {error.message}</p>}

      {data && collections.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No collections yet. Create one to start comparing models.
        </div>
      )}

      {collections.length > 0 && (
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              {/* w-full + max-w-0: the title column takes the remaining width and wraps instead of pushing the table wider. */}
              <th className="w-full max-w-0 border-b px-2 py-1.5 font-medium">Title</th>
              <th className="whitespace-nowrap border-b px-2 py-1.5 font-medium">Status</th>
              <th className="whitespace-nowrap border-b px-2 py-1.5 font-medium text-right">Grid</th>
              <th className="whitespace-nowrap border-b px-2 py-1.5 text-right font-medium">Cells</th>
              <th className="whitespace-nowrap border-b px-2 py-1.5 font-medium">Updated</th>
              <th className="border-b px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {collections.map((c) => (
              <tr
                key={c.slug}
                id={`collection-${c.slug}`}
                className={`group cursor-pointer hover:bg-accent/40 focus-visible:outline-none ${selected === c.slug ? 'bg-accent/50 ring-2 ring-inset ring-ring' : ''}`}
                tabIndex={0}
                aria-selected={selected === c.slug}
                onFocus={() => {
                  if (selected !== c.slug) select(c.slug);
                }}
                onClick={(e) => {
                  // Links and buttons inside the row keep their own behaviour.
                  if ((e.target as HTMLElement).closest('a, button')) return;
                  if (e.metaKey || e.ctrlKey) window.open(`/c/${c.slug}`, '_blank');
                  else navigate(`/c/${c.slug}`);
                }}
              >
                <td className="w-full max-w-0 border-b px-2 py-1.5">
                  <Link to={`/c/${c.slug}`} className="font-medium break-words hover:underline" tabIndex={-1}>
                    {c.title || c.slug}
                  </Link>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">{c.slug}</span>
                  {c.description && (
                    <WithTooltip label={<div className="max-w-md whitespace-pre-wrap">{c.description}</div>}>
                      <div className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.description}</div>
                    </WithTooltip>
                  )}
                </td>
                <td className="border-b px-2 py-1.5">
                  <Badge variant={c.status === 'live' ? 'green' : 'muted'}>{c.status}</Badge>
                </td>
                <td className="whitespace-nowrap border-b px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {c.rows} × {c.columns}
                </td>
                <td className="whitespace-nowrap border-b px-2 py-1.5 text-right">
                  <span className="inline-flex items-center justify-end gap-1">
                    <CellCounts succeeded={c.succeeded} inFlight={c.inFlight} queued={c.queued} failed={c.failed} total={c.cells} />
                    <ProgressBadge state={c.progress} />
                  </span>
                </td>
                <td className="whitespace-nowrap border-b px-2 py-1.5 text-muted-foreground" title={c.updatedAt}>
                  {relativeTime(c.updatedAt)}
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <WithTooltip label="Delete collection">
                    <Button
                      variant="ghost"
                      size="iconSm"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(`Delete "${c.title || c.slug}" and all its generations? Assets are kept.`)) {
                          remove.mutate({ collection: c.slug });
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </WithTooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <NewCollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export function CellCounts({
  succeeded,
  inFlight,
  queued,
  failed,
  total,
}: {
  succeeded: number;
  inFlight: number;
  queued: number;
  failed: number;
  total?: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
      <WithTooltip label="succeeded">
        <Badge variant="green">{succeeded}</Badge>
      </WithTooltip>
      {inFlight > 0 && (
        <WithTooltip label="in flight">
          <Badge variant="blue">
            <Spinner className="size-2.5 text-current" />
            {inFlight}
          </Badge>
        </WithTooltip>
      )}
      {queued > 0 && (
        <WithTooltip label="queued">
          <Badge variant="outline">{queued} queued</Badge>
        </WithTooltip>
      )}
      {failed > 0 && (
        <WithTooltip label="failed / unsupported / needs attention">
          <Badge variant="red">{failed}</Badge>
        </WithTooltip>
      )}
      {total !== undefined && <span className="ml-1 text-[11px] text-muted-foreground">/ {total}</span>}
    </span>
  );
}

function NewCollectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [live, setLive] = useState(true);
  const create = useCommand('collections.create', {
    onSuccess: (view) => {
      onOpenChange(false);
      navigate(`/c/${view.slug}`);
    },
  });

  useEffect(() => {
    if (open) {
      setTitle('');
      setSlug('');
      setSlugTouched(false);
      setLive(true);
    }
  }, [open]);

  const effectiveSlug = slugTouched ? slug : slugify(title);
  const status: CollectionStatus = live ? 'live' : 'paused';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!effectiveSlug) return;
            create.mutate({ slug: effectiveSlug, title: title.trim() || effectiveSlug, status });
          }}
        >
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>A grid of prompts (rows) against models (columns).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="nc-title">Title</Label>
            <Input id="nc-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Neon cats" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="nc-slug">Slug</Label>
            <Input
              id="nc-slug"
              className="font-mono"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value.toLowerCase()).length ? e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') : '');
              }}
              placeholder="neon-cats"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="nc-live" checked={live} onCheckedChange={setLive} />
            <Label htmlFor="nc-live" className="cursor-pointer">
              {live ? 'Live — cells generate as soon as rows and columns exist' : 'Paused — edit freely, nothing generates'}
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!effectiveSlug || create.isPending}>
              {create.isPending && <Spinner className="text-current" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
