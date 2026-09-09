import { Link } from 'react-router';
import { assetThumbUrl, isActiveStatus, type CellView } from '@imaginator/core';
import { RefreshCw, RotateCcw, X } from 'lucide-react';
import { useCommand } from '@/api/queries';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const CELL_SIZE = 148;

const RETRYABLE = new Set(['failed', 'unsupported', 'needs_attention']);

export function GridCell({ slug, cell }: { slug: string; cell: CellView | undefined }) {
  if (!cell) return <div className="text-[11px] text-muted-foreground">–</div>;
  const status = cell.status;
  const active = status !== 'missing' && isActiveStatus(status);
  const thumbs = cell.thumbnails.length ? cell.thumbnails : cell.outputs.map(assetThumbUrl);
  const hasImage = status === 'succeeded' && thumbs.length > 0;
  const tooltip = cell.error?.message;

  return (
    <div className="group relative" style={{ width: CELL_SIZE, height: CELL_SIZE }}>
      <Link
        to={`/c/${slug}/${cell.row}/${cell.column}`}
        className={cn(
          'block size-full overflow-hidden rounded border bg-muted/40',
          hasImage ? 'hover:ring-2 hover:ring-ring' : 'flex items-center justify-center hover:bg-muted',
        )}
        title={cell.address}
      >
        {hasImage ? (
          thumbs.length === 1 ? (
            <img src={thumbs[0]} alt={cell.address} className="size-full object-cover" loading="lazy" draggable={false} />
          ) : (
            <div className={cn('grid size-full gap-px', thumbs.length <= 4 ? 'grid-cols-2' : 'grid-cols-3')}>
              {thumbs.slice(0, 9).map((t, i) => (
                <img key={i} src={t} alt={`${cell.address} #${i + 1}`} className="size-full object-cover" loading="lazy" draggable={false} />
              ))}
            </div>
          )
        ) : (
          <StatusBadge status={status} tooltip={tooltip} />
        )}
      </Link>

      {/* Bottom-left hints */}
      <div className="pointer-events-none absolute bottom-1 left-1 flex flex-wrap gap-1">
        {cell.versions > 1 && (
          <Badge variant="secondary" className="pointer-events-auto bg-black/60 text-white border-transparent dark:bg-black/60">
            v{cell.versions}
          </Badge>
        )}
        {cell.droppedKeys && cell.droppedKeys.length > 0 && (
          <WithTooltip label={`Ignored by this model: ${cell.droppedKeys.join(', ')}`}>
            <Badge variant="amber" className="pointer-events-auto">
              dropped {cell.droppedKeys.join(', ')}
            </Badge>
          </WithTooltip>
        )}
        {hasImage && cell.error && (
          <WithTooltip label={cell.error.message}>
            <Badge variant="red" className="pointer-events-auto">!</Badge>
          </WithTooltip>
        )}
      </div>

      {/* Hover actions */}
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <CellActions address={cell.address} status={status} active={active} />
      </div>
    </div>
  );
}

export function CellActions({
  address,
  status,
  active,
  size = 'iconSm',
  labels,
}: {
  address: string;
  status: string;
  active: boolean;
  size?: 'iconSm' | 'sm';
  labels?: boolean;
}) {
  const regenerate = useCommand('cells.regenerate');
  const retry = useCommand('cells.retry');
  const cancel = useCommand('cells.cancel');
  const cls = 'bg-card/90 shadow-sm border';
  return (
    <>
      {RETRYABLE.has(status) && (
        <WithTooltip label="Retry with a fresh generation">
          <Button variant="outline" size={size} className={cls} disabled={retry.isPending} onClick={() => retry.mutate({ cell: address })}>
            <RotateCcw />
            {labels && 'Retry'}
          </Button>
        </WithTooltip>
      )}
      {active && (
        <WithTooltip label="Cancel the in-flight generation">
          <Button variant="outline" size={size} className={cls} disabled={cancel.isPending} onClick={() => cancel.mutate({ cell: address })}>
            <X />
            {labels && 'Cancel'}
          </Button>
        </WithTooltip>
      )}
      <WithTooltip label="Regenerate: another sample of the same request">
        <Button
          variant="outline"
          size={size}
          className={cls}
          disabled={regenerate.isPending || status === 'missing'}
          onClick={() => regenerate.mutate({ cell: address })}
        >
          <RefreshCw />
          {labels && 'Regenerate'}
        </Button>
      </WithTooltip>
    </>
  );
}
