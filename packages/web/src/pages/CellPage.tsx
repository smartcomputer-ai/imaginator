import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { assetThumbUrl, assetUrl, INPUT_ROLES, type CellView, type Generation, type Input, type InputRole } from '@imaginator/core';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CornerDownRight, Download, ExternalLink, Hand, ImagePlus, Images, Pin, PinOff, X } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useApi, useCell, useCollection, useCollections, useCommand, useGeneration, useImpact } from '@/api/queries';
import { StatusBadge } from '@/components/StatusBadge';
import { CellActions, isCellActive } from '@/features/grid/GridCell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn, durationMs, formatDuration, relativeTime } from '@/lib/utils';
import { useEscapeTo } from '@/lib/useEscapeTo';
import { toast } from 'sonner';

export function CellPage() {
  const { slug = '', row = '', col = '' } = useParams();
  const address = `${slug}/${row}/${col}`;
  useEvents(slug);
  useEscapeTo(`/c/${slug}`);
  const cellQ = useCell(address);
  const navigate = useNavigate();
  const addRows = useCommand('rows.add');
  const regenerate = useCommand('cells.regenerate');
  const pin = useCommand('cells.pin');
  const unpin = useCommand('cells.unpin');
  const impactQ = useImpact(address);

  // Neighbouring cells in grid order: ← → move across columns, ↑ ↓ across rows.
  const collectionQ = useCollection(slug);
  const rowIds = collectionQ.data?.rows.map((r) => r.id) ?? [];
  const colIds = collectionQ.data?.columns.map((c) => c.id) ?? [];
  const rowIndex = rowIds.indexOf(row);
  const colIndex = colIds.indexOf(col);
  const neighbour = (dr: number, dc: number): string | undefined => {
    if (rowIndex < 0 || colIndex < 0) return undefined;
    const r = rowIds[rowIndex + dr];
    const c = colIds[colIndex + dc];
    return r !== undefined && c !== undefined ? `/c/${slug}/${r}/${c}` : undefined;
  };
  const nav = { left: neighbour(0, -1), right: neighbour(0, 1), up: neighbour(-1, 0), down: neighbour(1, 0) };
  useEffect(() => {
    const keys: Record<string, string | undefined> = { ArrowLeft: nav.left, ArrowRight: nav.right, ArrowUp: nav.up, ArrowDown: nav.down };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.key in keys) || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const to = keys[e.key];
      if (!to) return;
      e.preventDefault();
      navigate(to);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav.left, nav.right, nav.up, nav.down, navigate]);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>();
  // Fullscreen view of one output; stays open while arrow keys move to other cells.
  const [lightbox, setLightbox] = useState<number | null>(null);
  const current = cellQ.data?.current;
  const versions = cellQ.data?.versions ?? [];
  const currentVersion = current?.version;

  // Moving to another cell drops an explicit version pick; it belonged to the previous cell.
  useEffect(() => {
    setSelectedVersion(undefined);
    setLightbox((l) => (l === null ? null : 0));
  }, [address]);

  // Follow the current version until the user picks one explicitly.
  useEffect(() => {
    if (selectedVersion !== undefined && !versions.some((v) => v.version === selectedVersion)) setSelectedVersion(undefined);
  }, [versions, selectedVersion]);

  const wantVersion = selectedVersion ?? currentVersion;
  const needsFetch = wantVersion !== undefined && wantVersion !== currentVersion;
  const genQ = useGeneration(needsFetch ? `${address}#${wantVersion}` : undefined);
  const generation: Generation | undefined = needsFetch ? genQ.data?.generation : current;

  if (cellQ.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Spinner /> Loading {address}…
      </div>
    );
  }
  if (cellQ.error || !cellQ.data) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not load cell {address}: {cellQ.error?.message ?? 'not found'}
      </div>
    );
  }
  const { cell } = cellQ.data;
  const active = isCellActive(cell.status);
  const latestVersion = cell.latest?.version;
  const selected = versions.find((v) => v.version === wantVersion);
  const pinnable = !!selected && selected.status === 'succeeded' && selected.requestHash === cell.hash;
  const isPinned = !!selected && cell.pin?.generation === selected.id;
  const impact = impactQ.data;
  // A follow-up row edits this row's current output, column by column.
  const addFollowUp = () =>
    addRows.mutate(
      { collection: slug, rows: [{ prompt: '', inputs: [{ row, role: 'init' }], position: rowIndex + 1 }] },
      { onSuccess: (out) => navigate(`/c/${slug}/${out.rows[0]!.id}/${col}`) },
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/c/${slug}`}>
            <ArrowLeft /> {slug}
          </Link>
        </Button>
        <div className="flex items-center rounded-md border">
          <WithTooltip label="Previous column (←)">
            <Button variant="ghost" size="iconSm" disabled={!nav.left} onClick={() => nav.left && navigate(nav.left)}>
              <ChevronLeft />
            </Button>
          </WithTooltip>
          <WithTooltip label="Previous row (↑)">
            <Button variant="ghost" size="iconSm" disabled={!nav.up} onClick={() => nav.up && navigate(nav.up)}>
              <ChevronUp />
            </Button>
          </WithTooltip>
          <WithTooltip label="Next row (↓)">
            <Button variant="ghost" size="iconSm" disabled={!nav.down} onClick={() => nav.down && navigate(nav.down)}>
              <ChevronDown />
            </Button>
          </WithTooltip>
          <WithTooltip label="Next column (→)">
            <Button variant="ghost" size="iconSm" disabled={!nav.right} onClick={() => nav.right && navigate(nav.right)}>
              <ChevronRight />
            </Button>
          </WithTooltip>
        </div>
        <span className="font-mono text-sm font-semibold">
          {row}/{col}
        </span>
        <StatusBadge status={cell.status} tooltip={cell.error?.message ?? cell.blocked} />
        {cell.blocked && <span className="text-xs text-muted-foreground">{cell.blocked}</span>}
        {cell.generation && cell.status !== 'succeeded' && cell.status !== 'missing' && (
          <WithTooltip label="The latest attempt did not succeed; the previous success stays current and feeds dependents">
            <Badge variant="green">current v{cell.version}</Badge>
          </WithTooltip>
        )}
        {cell.stale && (
          <WithTooltip label="Older result: the content changed and no new success exists yet">
            <Badge variant="amber">stale</Badge>
          </WithTooltip>
        )}
        {cell.pin && (
          <Badge variant={cell.pin.active ? 'violet' : 'muted'}>
            <Pin className="size-2.5" /> pinned v{cell.pin.version}
            {!cell.pin.active && ' (inactive)'}
          </Badge>
        )}
        {cell.hold && (
          <WithTooltip label="Cancelled by you: not recreated until retry or regenerate">
            <Badge variant="outline">
              <Hand className="size-2.5" /> held
            </Badge>
          </WithTooltip>
        )}
        {cell.versions > 1 && <Badge variant="secondary">{cell.versions} versions</Badge>}
        {cell.droppedKeys && cell.droppedKeys.length > 0 && <Badge variant="amber">dropped: {cell.droppedKeys.join(', ')}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <WithTooltip label="Add a row below that edits this row's output in every column">
            <Button variant="outline" size="sm" className="bg-card/90 shadow-sm border" disabled={addRows.isPending} onClick={addFollowUp}>
              <CornerDownRight /> Follow up
            </Button>
          </WithTooltip>
          {cell.generation && (
            <WithTooltip label="Regenerate while pinning the current success first, so dependents do not move until you pin the new sample">
              <Button variant="outline" size="sm" className="bg-card/90 shadow-sm border" disabled={regenerate.isPending} onClick={() => regenerate.mutate({ cell: address, holdCurrent: true })}>
                <Pin /> Sample, hold current
              </Button>
            </WithTooltip>
          )}
          <CellActions address={address} status={cell.status} active={active} hold={cell.hold} size="sm" labels />
        </div>
      </div>
      {impact && impact.transitive > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          <span>
            A new current output here reaches <strong>{impact.transitive}</strong> cell{impact.transitive === 1 ? '' : 's'}
            {impact.collections.length > 1 || impact.collections[0] !== slug ? ` across ${impact.collections.join(', ')}` : ''}.
          </span>
          {impact.sourcePinned && <span>Source is pinned: sampling does not cascade.</span>}
          {impact.paused.collections.length + impact.paused.rows.length > 0 && <span>Paused: {[...impact.paused.collections, ...impact.paused.rows].join(', ')}.</span>}
          {impact.pinned.length > 0 && <span>Pinned downstream: {impact.pinned.join(', ')} (a pin does not stop changed inputs).</span>}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-auto p-3">
          {generation ? (
            <GenerationImages generation={generation} slug={slug} onOpen={setLightbox} />
          ) : needsFetch && genQ.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Loading version {wantVersion}…
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              No generation yet for this cell.
            </div>
          )}

          {versions.length > 0 && (
            <div className="mt-3">
              <Label>Versions</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[...versions]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      title={`v${v.version} · ${v.status} · ${v.id}${v.forced ? ' · forced' : ''}${v.version === currentVersion ? ' · current' : ''}${v.version === latestVersion && v.version !== currentVersion ? ' · latest attempt' : ''}${cell.pin?.generation === v.id ? ' · pinned' : ''}`}
                      className={cn(
                        'relative size-16 overflow-hidden rounded border bg-muted cursor-pointer',
                        v.version === wantVersion ? 'ring-2 ring-ring' : 'hover:ring-1 hover:ring-ring/50',
                        v.requestHash !== cell.hash && 'opacity-60',
                      )}
                      onClick={() => setSelectedVersion(v.version)}
                    >
                      {v.outputs[0] ? (
                        <img src={assetThumbUrl(v.outputs[0])} alt={`v${v.version}`} className="size-full object-cover" loading="lazy" />
                      ) : (
                        <div className="flex size-full items-center justify-center">
                          <StatusBadge status={v.status} className="scale-90" />
                        </div>
                      )}
                      <span className="absolute left-0 top-0 rounded-br bg-black/60 px-1 text-[10px] text-white">v{v.version}</span>
                      {v.version === currentVersion && <span className="absolute bottom-0 right-0 rounded-tl bg-emerald-600 px-1 text-[9px] text-white">current</span>}
                      {v.version === latestVersion && v.version !== currentVersion && <span className="absolute bottom-0 right-0 rounded-tl bg-sky-600 px-1 text-[9px] text-white">latest</span>}
                      {cell.pin?.generation === v.id && (
                        <span className={cn('absolute right-0 top-0 rounded-bl px-1 text-[9px] text-white', cell.pin.active ? 'bg-violet-600' : 'bg-zinc-500')}>
                          <Pin className="inline size-2.5" />
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-auto border-l bg-card p-3 text-xs">
          <div className="mb-3 grid gap-2">
            {selected && (
              <div className="flex flex-wrap items-center gap-1">
                <Label>Selected v{selected.version}</Label>
                {isPinned ? (
                  <Button variant="outline" size="xs" disabled={unpin.isPending} onClick={() => unpin.mutate({ cell: address })}>
                    <PinOff /> Unpin
                  </Button>
                ) : (
                  <WithTooltip label={pinnable ? 'Make this version current: dependents build on it until you pin another or unpin' : 'Only a succeeded version matching the current content can be pinned'}>
                    <Button variant="outline" size="xs" disabled={!pinnable || pin.isPending} onClick={() => pin.mutate({ cell: address, version: selected.version })}>
                      <Pin /> Pin as current
                    </Button>
                  </WithTooltip>
                )}
              </div>
            )}
            {(cellQ.data.precedents.length > 0 || cellQ.data.dependents.length > 0) && (
              <div className="grid gap-1">
                {cellQ.data.precedents.length > 0 && (
                  <div>
                    <Label>Reads from</Label>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {cellQ.data.precedents.map((a) => (
                        <Link key={a} to={`/c/${a}`} className="font-mono text-[11px] text-primary hover:underline">
                          {a}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {cellQ.data.dependents.length > 0 && (
                  <div>
                    <Label>Feeds</Label>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {cellQ.data.dependents.map((a) => (
                        <Link key={a} to={`/c/${a}`} className="font-mono text-[11px] text-primary hover:underline">
                          {a}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {generation ? <GenerationDetails generation={generation} /> : <p className="text-muted-foreground">Nothing to show yet.</p>}
        </aside>
      </div>

      {lightbox !== null && (
        <Lightbox
          address={address}
          cell={cell}
          generation={generation}
          loading={needsFetch && genQ.isLoading}
          output={lightbox}
          onOutput={setLightbox}
          onClose={() => setLightbox(null)}
          nav={nav}
        />
      )}
    </div>
  );
}

/**
 * Fullscreen view of one output. Arrow keys keep moving between cells (the
 * page-level handler stays active); Escape closes the view instead of leaving
 * the page. Clicking the backdrop closes it too.
 */
function Lightbox({
  address,
  cell,
  generation,
  loading,
  output,
  onOutput,
  onClose,
  nav,
}: {
  address: string;
  cell: CellView;
  generation: Generation | undefined;
  loading: boolean;
  output: number;
  onOutput: (i: number) => void;
  onClose: () => void;
  nav: { left?: string; right?: string; up?: string; down?: string };
}) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    // Capture phase: runs before the page-level "Escape goes up" handler, which honors preventDefault.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  const outputs = generation?.outputs ?? [];
  const index = Math.min(output, Math.max(0, outputs.length - 1));
  const id = outputs[index];
  const ghost = 'text-white hover:bg-white/10 hover:text-white';
  const edge = 'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 disabled:opacity-20 cursor-pointer';

  return (
    <div role="dialog" aria-modal="true" aria-label={`${address} fullscreen`} className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white" onClick={onClose}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center rounded-md border border-white/20">
          <Button variant="ghost" size="iconSm" className={ghost} disabled={!nav.left} onClick={() => nav.left && navigate(nav.left)} title="Previous column (←)">
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="iconSm" className={ghost} disabled={!nav.up} onClick={() => nav.up && navigate(nav.up)} title="Previous row (↑)">
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="iconSm" className={ghost} disabled={!nav.down} onClick={() => nav.down && navigate(nav.down)} title="Next row (↓)">
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="iconSm" className={ghost} disabled={!nav.right} onClick={() => nav.right && navigate(nav.right)} title="Next column (→)">
            <ChevronRight />
          </Button>
        </div>
        <span className="font-mono font-semibold">{address}</span>
        {generation && <span className="text-white/60">v{generation.version}</span>}
        {outputs.length > 1 && (
          <span className="text-white/60">
            {index + 1}/{outputs.length}
          </span>
        )}
        <StatusBadge status={cell.status} tooltip={cell.error?.message ?? cell.blocked} />
        <span className="ml-auto hidden text-xs text-white/50 md:inline">← → columns · ↑ ↓ rows · Esc close</span>
        {id && (
          <Button variant="ghost" size="sm" className={ghost} asChild>
            <a href={assetUrl(id)} target="_blank" rel="noreferrer">
              <ExternalLink /> Original
            </a>
          </Button>
        )}
        <Button variant="ghost" size="iconSm" className={ghost} onClick={onClose} title="Close (Esc)">
          <X />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <button type="button" className={cn(edge, 'left-3')} disabled={!nav.left} onClick={(e) => { e.stopPropagation(); if (nav.left) navigate(nav.left); }} title="Previous column (←)">
          <ChevronLeft />
        </button>
        <div className="absolute inset-0 flex items-center justify-center p-4">
          {id ? (
            <img src={assetUrl(id)} alt={id} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} draggable={false} />
          ) : loading ? (
            <div className="flex items-center gap-2 text-white/70">
              <Spinner /> Loading…
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-white/30 p-8 text-center text-sm text-white/70" onClick={(e) => e.stopPropagation()}>
              <StatusBadge status={generation?.status ?? cell.status} className="mb-2" />
              <p>{generation?.error?.message ?? cell.blocked ?? 'No image for this cell yet.'}</p>
            </div>
          )}
        </div>
        <button type="button" className={cn(edge, 'right-3')} disabled={!nav.right} onClick={(e) => { e.stopPropagation(); if (nav.right) navigate(nav.right); }} title="Next column (→)">
          <ChevronRight />
        </button>
      </div>

      {outputs.length > 1 && (
        <div className="flex justify-center gap-1.5 px-3 py-2" onClick={(e) => e.stopPropagation()}>
          {outputs.map((o, i) => (
            <button
              key={o}
              type="button"
              className={cn('size-14 overflow-hidden rounded border border-white/20 cursor-pointer', i === index ? 'ring-2 ring-white' : 'opacity-60 hover:opacity-100')}
              onClick={() => onOutput(i)}
              title={o}
            >
              <img src={assetThumbUrl(o)} alt={o} className="size-full object-cover" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GenerationImages({ generation, slug, onOpen }: { generation: Generation; slug: string; onOpen: (index: number) => void }) {
  if (!generation.outputs.length) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-8 text-sm text-muted-foreground">
        <div className="text-center">
          <StatusBadge status={generation.status} className="mb-2" />
          {generation.error && <p className="max-w-md text-destructive">{generation.error.message}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className={cn('grid gap-3', generation.outputs.length > 1 && 'grid-cols-2')}>
      {generation.outputs.map((id, i) => (
        <figure key={id} className="flex flex-col gap-1">
          <button type="button" className="overflow-hidden rounded-md border bg-muted cursor-zoom-in" onClick={() => onOpen(i)} title="Open fullscreen">
            <img src={assetUrl(id)} alt={id} className="max-h-[70vh] w-full object-contain" />
          </button>
          <figcaption className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{id}</span>
            <div className="ml-auto flex items-center gap-1">
              <UseAsInput assetId={id} slug={slug} source={{ collection: generation.collection, row: generation.row, column: generation.column }} />
              <Button variant="ghost" size="xs" asChild>
                <a href={assetUrl(id)} target="_blank" rel="noreferrer">
                  <ExternalLink /> Original
                </a>
              </Button>
              <Button variant="ghost" size="xs" asChild>
                <a href={assetUrl(id)} download={`${id}`}>
                  <Download /> Download
                </a>
              </Button>
              <Button variant="ghost" size="xs" asChild>
                <Link to={`/assets?focus=${id}`}>
                  <Images /> Open in assets
                </Link>
              </Button>
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function UseAsInput({ assetId, slug, source }: { assetId: string; slug: string; source: { collection: string; row: string; column: string } }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'reference' | 'asset'>('reference');
  const [targetSlug, setTargetSlug] = useState(slug);
  const collectionsQ = useCollections({ enabled: open });
  const { data: collection } = useCollection(targetSlug, { enabled: open });
  const rows = [...(collection?.rows ?? [])].sort((a, b) => a.position - b.position);
  const [rowId, setRowId] = useState<string | undefined>();
  const [role, setRole] = useState<InputRole>('init');
  const row = rows.find((r) => r.id === rowId) ?? rows[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          <ImagePlus /> Use as input
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid gap-2">
          <div className="grid gap-1">
            <Label>Kind</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'reference' | 'asset')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reference">Live reference: this cell's current output</SelectItem>
                <SelectItem value="asset">Frozen asset: exactly this image</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'reference' ? 'Follows regenerates and pins of this cell, in every column of the target row.' : 'Never changes, even if this cell is regenerated.'}
            </p>
          </div>
          <div className="grid gap-1">
            <Label>Collection</Label>
            <Select
              value={targetSlug}
              onValueChange={(v) => {
                setTargetSlug(v);
                setRowId(undefined);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(collectionsQ.data?.collections ?? [{ slug }]).map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Row</Label>
            <Select value={row?.id ?? ''} onValueChange={setRowId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose row" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="font-mono text-muted-foreground">{r.id}</span> {r.prompt.slice(0, 50) || '(empty)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as InputRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INPUT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={!row}
            onClick={async () => {
              if (!row) return;
              const maskFor = role === 'mask' ? { maskFor: Math.max(0, row.inputs.findIndex((i) => i.role === 'init')) } : {};
              const input: Input =
                mode === 'asset'
                  ? { asset: assetId, role, ...maskFor }
                  : { row: source.row, column: source.column, ...(source.collection !== targetSlug ? { collection: source.collection } : {}), role, ...maskFor };
              await api('rows.update', { collection: targetSlug, row: row.id, inputs: [...row.inputs, input] });
              toast.success(mode === 'asset' ? `Added ${assetId} to ${targetSlug}/${row.id} as ${role}` : `${targetSlug}/${row.id} now reads ${source.collection}/${source.row}/${source.column} as ${role}`);
              setOpen(false);
            }}
          >
            Add to {targetSlug}/{row?.id ?? 'row'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function GenerationDetails({ generation: g }: { generation: Generation }) {
  const queuedToStart = durationMs(g.timing.queuedAt, g.timing.startedAt);
  const run = durationMs(g.timing.startedAt ?? g.timing.queuedAt, g.timing.finishedAt);
  return (
    <div className="grid gap-3">
      <div>
        <Label>Generation</Label>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">id</dt>
          <dd className="font-mono">{g.id}</dd>
          <dt className="text-muted-foreground">version</dt>
          <dd>
            v{g.version}
            {g.forced && <Badge variant="outline" className="ml-1">forced</Badge>}
          </dd>
          <dt className="text-muted-foreground">status</dt>
          <dd>
            <StatusBadge status={g.status} />
          </dd>
          <dt className="text-muted-foreground">attempt</dt>
          <dd>{g.attempt}</dd>
          <dt className="text-muted-foreground">model</dt>
          <dd className="font-mono">{g.request.model}</dd>
          <dt className="text-muted-foreground">hash</dt>
          <dd className="truncate font-mono" title={g.requestHash}>
            {g.requestHash.slice(0, 16)}…
          </dd>
        </dl>
      </div>

      {g.error && (
        <div>
          <Label>Error</Label>
          <p className="mt-1 whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            {g.error.message}
            {g.error.code && <span className="ml-1 font-mono opacity-70">[{g.error.code}]</span>}
            {g.error.retryable && <span className="ml-1 opacity-70">(retryable)</span>}
          </p>
        </div>
      )}

      <div>
        <Label>Timing</Label>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">queued</dt>
          <dd title={g.timing.queuedAt}>{relativeTime(g.timing.queuedAt)}</dd>
          <dt className="text-muted-foreground">started</dt>
          <dd title={g.timing.startedAt}>
            {g.timing.startedAt ? relativeTime(g.timing.startedAt) : '–'}
            {queuedToStart !== undefined && <span className="text-muted-foreground"> (waited {formatDuration(queuedToStart)})</span>}
          </dd>
          <dt className="text-muted-foreground">finished</dt>
          <dd title={g.timing.finishedAt}>
            {g.timing.finishedAt ? relativeTime(g.timing.finishedAt) : '–'}
            {run !== undefined && <span className="text-muted-foreground"> (took {formatDuration(run)})</span>}
          </dd>
          <dt className="text-muted-foreground">cost</dt>
          <dd>{g.cost === undefined ? '–' : `$${g.cost.toFixed(4)}`}</dd>
        </dl>
      </div>

      {g.request.droppedKeys.length > 0 && (
        <div>
          <Label>Dropped keys</Label>
          <p className="mt-1 text-amber-700 dark:text-amber-300">Ignored by this model: {g.request.droppedKeys.join(', ')}</p>
        </div>
      )}

      <details open>
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">Resolved request</summary>
        <pre className="mt-1 max-h-96 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[11px] leading-snug">{JSON.stringify(g.request, null, 2)}</pre>
      </details>

      {g.providerRef && (
        <details>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">Provider ref</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[11px] leading-snug">{JSON.stringify(g.providerRef, null, 2)}</pre>
        </details>
      )}
      {g.providerMeta !== undefined && (
        <details>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">Provider meta</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[11px] leading-snug">{JSON.stringify(g.providerMeta, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
