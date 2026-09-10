import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { assetThumbUrl, assetUrl, INPUT_ROLES, isActiveStatus, type Generation, type InputRole } from '@imaginator/core';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, ImagePlus, Images } from 'lucide-react';
import { useEvents } from '@/api/events';
import { useApi, useCell, useCollection, useGeneration } from '@/api/queries';
import { StatusBadge } from '@/components/StatusBadge';
import { CellActions } from '@/features/grid/GridCell';
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
  const current = cellQ.data?.current;
  const versions = cellQ.data?.versions ?? [];
  const currentVersion = current?.version;

  // Moving to another cell drops an explicit version pick; it belonged to the previous cell.
  useEffect(() => setSelectedVersion(undefined), [address]);

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
  const active = cell.status !== 'missing' && isActiveStatus(cell.status);

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
        <StatusBadge status={cell.status} tooltip={cell.error?.message} />
        {cell.versions > 1 && <Badge variant="secondary">{cell.versions} versions</Badge>}
        {cell.droppedKeys && cell.droppedKeys.length > 0 && <Badge variant="amber">dropped: {cell.droppedKeys.join(', ')}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <CellActions address={address} status={cell.status} active={active} size="sm" labels />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-auto p-3">
          {generation ? (
            <GenerationImages generation={generation} slug={slug} />
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
                      title={`v${v.version} · ${v.status} · ${v.id}${v.forced ? ' · forced' : ''}`}
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
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-auto border-l bg-card p-3 text-xs">
          {generation ? <GenerationDetails generation={generation} /> : <p className="text-muted-foreground">Nothing to show yet.</p>}
        </aside>
      </div>
    </div>
  );
}

function GenerationImages({ generation, slug }: { generation: Generation; slug: string }) {
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
      {generation.outputs.map((id) => (
        <figure key={id} className="flex flex-col gap-1">
          <a href={assetUrl(id)} target="_blank" rel="noreferrer" className="overflow-hidden rounded-md border bg-muted">
            <img src={assetUrl(id)} alt={id} className="max-h-[70vh] w-full object-contain" />
          </a>
          <figcaption className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{id}</span>
            <div className="ml-auto flex items-center gap-1">
              <UseAsInput assetId={id} slug={slug} />
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

function UseAsInput({ assetId, slug }: { assetId: string; slug: string }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const { data: collection } = useCollection(slug, { enabled: open });
  const rows = [...(collection?.rows ?? [])].sort((a, b) => a.position - b.position);
  const [rowId, setRowId] = useState<string | undefined>();
  const [role, setRole] = useState<InputRole>('reference');
  const row = rows.find((r) => r.id === rowId) ?? rows[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          <ImagePlus /> Use as input
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="grid gap-2">
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
              const input = role === 'mask' ? { asset: assetId, role, maskFor: Math.max(0, row.inputs.findIndex((i) => i.role === 'init')) } : { asset: assetId, role };
              await api('rows.update', { collection: slug, row: row.id, inputs: [...row.inputs, input] });
              toast.success(`Added ${assetId} to ${row.id} as ${role}`);
              setOpen(false);
            }}
          >
            Add to {row?.id ?? 'row'}
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
