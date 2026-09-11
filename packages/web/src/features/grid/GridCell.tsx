import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { assetThumbUrl, assetUrl, isActiveStatus, type CellStatus, type CellView, type GenerationStatus } from '@imaginator/core';
import { Hand, Pin, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useCommand } from '@/api/queries';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Hover preview is 50% larger than the cell and never crops. */
function previewSize(cellSize: number): number {
  return Math.round(cellSize * 1.5);
}

const RETRYABLE = new Set(['failed', 'unsupported', 'needs_attention']);
const NOT_GENERATION: CellStatus[] = ['missing', 'blocked', 'skipped'];

/** The cell status is the latest attempt's status, or missing/blocked/skipped. */
export function isCellActive(status: CellStatus): boolean {
  return !NOT_GENERATION.includes(status) && isActiveStatus(status as GenerationStatus);
}

export function GridCell({ slug, cell, size }: { slug: string; cell: CellView | undefined; size: number }) {
  if (!cell) return <div className="text-[11px] text-muted-foreground">–</div>;
  const status = cell.status;
  const active = isCellActive(status);
  const thumbs = cell.thumbnails.length ? cell.thumbnails : cell.outputs.map(assetThumbUrl);
  // A current success (or a stale older one) shows even while the latest attempt is failing or running.
  const hasImage = thumbs.length > 0 && status !== 'skipped';
  const tooltip = cell.error?.message ?? cell.blocked ?? (status === 'skipped' ? `Row ${cell.row} does not run in column ${cell.column}` : undefined);
  const [preview, setPreview] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onEnter = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(true), 250);
  };
  const onLeave = () => {
    window.clearTimeout(timer.current);
    setPreview(false);
  };

  return (
    <div
      className="group relative"
      style={{ width: size, height: size }}
      onMouseEnter={hasImage ? onEnter : undefined}
      onMouseLeave={hasImage ? onLeave : undefined}
    >
      <Link
        to={`/c/${slug}/${cell.row}/${cell.column}`}
        className={cn(
          'block size-full overflow-hidden rounded border bg-muted/40',
          hasImage ? 'hover:ring-2 hover:ring-ring' : 'flex items-center justify-center hover:bg-muted',
          status === 'skipped' && 'border-dashed bg-transparent',
        )}
        title={cell.address}
      >
        {hasImage ? (
          <div className={cn('size-full', cell.stale && 'opacity-50 grayscale-[35%]')}>
            {thumbs.length === 1 ? (
              <img src={thumbs[0]} alt={cell.address} className="size-full object-contain" loading="lazy" draggable={false} />
            ) : (
              <div className={cn('grid size-full gap-px', thumbs.length <= 4 ? 'grid-cols-2' : 'grid-cols-3')}>
                {thumbs.slice(0, 9).map((t, i) => (
                  <img key={i} src={t} alt={`${cell.address} #${i + 1}`} className="size-full object-contain" loading="lazy" draggable={false} />
                ))}
              </div>
            )}
          </div>
        ) : status === 'skipped' ? (
          <span className="text-[11px] text-muted-foreground/60">–</span>
        ) : (
          <div className="flex max-w-full flex-col items-center gap-1 p-1.5 text-center">
            <StatusBadge status={status} tooltip={tooltip} />
            {tooltip && size >= 110 && <span className="line-clamp-4 text-[10px] leading-tight text-muted-foreground">{tooltip}</span>}
          </div>
        )}
      </Link>
      {hasImage && (
        <HoverPreview
          to={`/c/${slug}/${cell.row}/${cell.column}`}
          urls={cell.urls.length ? cell.urls : cell.outputs.map(assetUrl)}
          address={cell.address}
          visible={preview}
          cellSize={size}
        />
      )}

      {/* Top-left: the latest attempt when it is not the picture being shown */}
      {hasImage && status !== 'succeeded' && (
        <div className="pointer-events-none absolute left-1 top-1">
          <StatusBadge status={status} tooltip={tooltip} className="pointer-events-auto" />
        </div>
      )}

      {/* Bottom-left hints */}
      <div className="pointer-events-none absolute bottom-1 left-1 flex flex-wrap gap-1">
        {cell.versions > 1 && (
          <Badge variant="secondary" className="pointer-events-auto bg-black/60 text-white border-transparent dark:bg-black/60">
            v{cell.versions}
          </Badge>
        )}
        {cell.stale && (
          <WithTooltip label={cell.blocked ?? 'Older result: the content changed and no new success exists yet'}>
            <Badge variant="amber" className="pointer-events-auto">stale</Badge>
          </WithTooltip>
        )}
        {cell.pin && (
          <WithTooltip label={cell.pin.active ? `Pinned to v${cell.pin.version}` : `Pin on v${cell.pin.version} is inactive (content changed)`}>
            <Badge variant={cell.pin.active ? 'violet' : 'muted'} className="pointer-events-auto">
              <Pin className="size-2.5" />
              v{cell.pin.version}
            </Badge>
          </WithTooltip>
        )}
        {cell.hold && (
          <WithTooltip label="Cancelled by you: not recreated until retry or regenerate">
            <Badge variant="outline" className="pointer-events-auto bg-card/80">
              <Hand className="size-2.5" /> held
            </Badge>
          </WithTooltip>
        )}
        {cell.droppedKeys && cell.droppedKeys.length > 0 && (
          <WithTooltip label={`Ignored by this model: ${cell.droppedKeys.join(', ')}`}>
            <Badge variant="amber" className="pointer-events-auto">
              dropped {cell.droppedKeys.join(', ')}
            </Badge>
          </WithTooltip>
        )}
        {hasImage && cell.error && status === 'succeeded' && (
          <WithTooltip label={cell.error.message}>
            <Badge variant="red" className="pointer-events-auto">!</Badge>
          </WithTooltip>
        )}
      </div>

      {/* Hover actions */}
      {status !== 'skipped' && (
        <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CellActions address={cell.address} status={status} active={active} hold={cell.hold} />
        </div>
      )}
    </div>
  );
}

export function CellActions({
  address,
  status,
  active,
  hold,
  size = 'iconSm',
  labels,
}: {
  address: string;
  status: string;
  active: boolean;
  hold?: boolean;
  size?: 'iconSm' | 'sm';
  labels?: boolean;
}) {
  const regenerate = useCommand('cells.regenerate');
  const retry = useCommand('cells.retry');
  const cancel = useCommand('cells.cancel');
  const cls = 'bg-card/90 shadow-sm border';
  const canRun = status !== 'missing' && status !== 'blocked' && status !== 'skipped';
  return (
    <>
      {(RETRYABLE.has(status) || hold) && (
        <WithTooltip label={hold ? 'Release the hold and run again' : 'Retry the failed attempt with a fresh generation'}>
          <Button variant="outline" size={size} className={cls} disabled={retry.isPending} onClick={() => retry.mutate({ cell: address })}>
            <RotateCcw />
            {labels && 'Retry'}
          </Button>
        </WithTooltip>
      )}
      {active && (
        <WithTooltip label="Cancel the in-flight generation and hold the cell">
          <Button variant="outline" size={size} className={cls} disabled={cancel.isPending} onClick={() => cancel.mutate({ cell: address })}>
            <X />
            {labels && 'Cancel'}
          </Button>
        </WithTooltip>
      )}
      <WithTooltip label="Regenerate: another sample of the same request">
        <Button variant="outline" size={size} className={cls} disabled={regenerate.isPending || !canRun} onClick={() => regenerate.mutate({ cell: address })}>
          <RefreshCw />
          {labels && 'Regenerate'}
        </Button>
      </WithTooltip>
    </>
  );
}

/**
 * Larger, uncropped preview of a cell's outputs, centered over the cell. It
 * lives inside the cell's hover group so it stays open while the pointer is on
 * it, and it is a link to the cell detail like the cell itself.
 */
function HoverPreview({ to, urls, address, visible, cellSize }: { to: string; urls: string[]; address: string; visible: boolean; cellSize: number }) {
  if (!visible) return null;
  const PREVIEW_SIZE = previewSize(cellSize);
  const offset = Math.round((cellSize - PREVIEW_SIZE) / 2);
  const shown = urls.slice(0, 4);
  return (
    <Link
      to={to}
      title={address}
      className="absolute z-40 flex items-center justify-center overflow-hidden rounded-md border bg-popover shadow-xl ring-1 ring-ring"
      style={{ top: offset, left: offset, width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
    >
      {shown.length === 1 ? (
        <img src={shown[0]} alt={address} className="max-h-full max-w-full object-contain" draggable={false} />
      ) : (
        <div className="grid size-full grid-cols-2 gap-px">
          {shown.map((u, i) => (
            <div key={u} className="flex items-center justify-center overflow-hidden">
              <img src={u} alt={`${address} #${i + 1}`} className="max-h-full max-w-full object-contain" draggable={false} />
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
