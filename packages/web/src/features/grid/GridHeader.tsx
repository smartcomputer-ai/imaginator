import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CollectionView } from '@imaginator/core';
import { Columns3, Copy, Download, Info, MoreHorizontal, Pencil, Rows3, Settings2, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { useApi, useCommand } from '@/api/queries';
import { CommonSettingsForm } from '@/components/CommonSettingsForm';
import { InlineTextarea } from '@/components/InlineEdit';
import { CellCounts } from '@/pages/CollectionsPage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { downloadJson } from '@/lib/utils';
import { toast } from 'sonner';
import { AddColumnDialog } from './AddColumnDialog';
import { formatUsd } from './ColumnHeader';
import { AddRowDialog } from './AddRowDialog';
import type { useCellSize } from './zoom';

export function GridHeader({ collection, zoom }: { collection: CollectionView; zoom: ReturnType<typeof useCellSize> }) {
  const navigate = useNavigate();
  const api = useApi();
  const slug = collection.slug;
  const update = useCommand('collections.update');
  const pause = useCommand('collections.pause');
  const resume = useCommand('collections.resume');
  const remove = useCommand('collections.delete', { onSuccess: () => navigate('/') });
  const [addColumn, setAddColumn] = useState(false);
  const [addRow, setAddRow] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const counts = countCells(collection);
  const spend = collection.cells.reduce<number | undefined>((sum, c) => (c.cost === undefined ? sum : (sum ?? 0) + c.cost), undefined);
  const defaultsCount = Object.keys(collection.defaults).length;

  const onExport = async () => {
    const { document } = await api('collections.export', { collection: slug });
    downloadJson(`${slug}.imaginator.json`, document);
  };
  const onImport = async (file: File) => {
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      toast.error('Not a JSON file');
      return;
    }
    const target = window.prompt('Import as slug (leave as-is to use the document slug):', (document as { collection?: { slug?: string } })?.collection?.slug ?? '');
    if (target === null) return;
    const view = await api('collections.import', { document: document as never, slug: target.trim() || undefined });
    toast.success(`Imported ${view.slug}`);
    navigate(`/c/${view.slug}`);
  };

  const editDescription = () => {
    const d = window.prompt('Description:', collection.description ?? '');
    if (d === null) return;
    update.mutate({ collection: slug, description: d.trim() || null });
  };

  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b bg-card/95 px-3 py-1.5 backdrop-blur">
      <div className="min-w-48 max-w-md flex-1">
        <InlineTextarea
          value={collection.title}
          singleLine
          rows={1}
          className="text-sm font-semibold"
          placeholder="Untitled"
          onCommit={(title) => update.mutate({ collection: slug, title })}
        />
      </div>
      <div className="ml-auto flex items-center gap-1">
        <div className="mr-4 flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="iconSm" className="text-muted-foreground" aria-label="Collection info" onClick={editDescription}>
              <Info />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md">
            <div className="font-mono text-[11px] text-muted-foreground">{slug}</div>
            {collection.description ? (
              <p className="mt-1 whitespace-pre-wrap">{collection.description}</p>
            ) : (
              <p className="mt-1 text-muted-foreground">No description. Click to add one.</p>
            )}
          </TooltipContent>
        </Tooltip>
        <CellCounts succeeded={counts.succeeded} inFlight={collection.inFlight} queued={collection.queued} failed={counts.failed} total={collection.cells.length} />
        {spend !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="tabular-nums">
                {formatUsd(spend)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Estimated spend on the current generations (cells without a price are not counted)</TooltipContent>
          </Tooltip>
        )}
        </div>
        <Popover open={defaultsOpen} onOpenChange={setDefaultsOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Settings2 /> Defaults{defaultsCount ? ` (${defaultsCount})` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end">
            <p className="mb-2 text-xs text-muted-foreground">Common settings applied to every row unless the row overrides them.</p>
            {defaultsOpen && (
              <CommonSettingsForm
                value={collection.defaults}
                saving={update.isPending}
                onSave={(defaults) => update.mutate({ collection: slug, defaults }, { onSuccess: () => setDefaultsOpen(false) })}
                onClear={() => update.mutate({ collection: slug, defaults: {} }, { onSuccess: () => setDefaultsOpen(false) })}
              />
            )}
          </PopoverContent>
        </Popover>
        <div className="flex items-center rounded-md border">
          <Button variant="ghost" size="sm" className="rounded-r-none" onClick={zoom.zoomOut} disabled={!zoom.canZoomOut} title="Smaller cells">
            <ZoomOut />
          </Button>
          <span className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground">{zoom.cellSize}px</span>
          <Button variant="ghost" size="sm" className="rounded-l-none" onClick={zoom.zoomIn} disabled={!zoom.canZoomIn} title="Larger cells">
            <ZoomIn />
          </Button>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border px-2 py-1">
          <Switch
            id="coll-live"
            checked={collection.status === 'live'}
            disabled={pause.isPending || resume.isPending}
            onCheckedChange={(live) => (live ? resume.mutate({ collection: slug }) : pause.mutate({ collection: slug }))}
          />
          <Label htmlFor="coll-live" className="cursor-pointer">
            <Badge variant={collection.status === 'live' ? 'green' : 'muted'}>{collection.status}</Badge>
          </Label>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddColumn(true)}>
          <Columns3 /> Add column
        </Button>
        <Button size="sm" onClick={() => setAddRow(true)}>
          <Rows3 /> Add row
        </Button>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void onExport()}>
              <Download /> Export JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => importRef.current?.click()}>
              <Upload /> Import JSON…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                const target = window.prompt('New slug for the copy:', `${slug}-copy`);
                if (!target) return;
                const view = await api('collections.duplicate', { collection: slug, slug: target.trim() });
                navigate(`/c/${view.slug}`);
              }}
            >
              <Copy /> Duplicate…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                const target = window.prompt('Rename slug to:', slug);
                if (!target || target.trim() === slug) return;
                const view = await api('collections.rename', { collection: slug, slug: target.trim() });
                navigate(`/c/${view.slug}`, { replace: true });
              }}
            >
              <Pencil /> Rename slug…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={editDescription}>
              <Pencil /> Description…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onSelect={() => {
                if (window.confirm(`Delete "${collection.title || slug}" and all its generations? Assets are kept.`)) remove.mutate({ collection: slug });
              }}
            >
              <Trash2 /> Delete collection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>


      <AddColumnDialog slug={slug} open={addColumn} onOpenChange={setAddColumn} existingIds={collection.columns.map((c) => c.id)} />
      <AddRowDialog slug={slug} open={addRow} onOpenChange={setAddRow} />
    </div>
  );
}

export function countCells(c: CollectionView) {
  let succeeded = 0;
  let failed = 0;
  for (const cell of c.cells) {
    if (cell.status === 'succeeded') succeeded++;
    else if (cell.status === 'failed' || cell.status === 'unsupported' || cell.status === 'needs_attention') failed++;
  }
  return { succeeded, failed };
}
