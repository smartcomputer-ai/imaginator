import type { CellStatus, GenerationStatus } from '@imaginator/core';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { WithTooltip } from '@/components/ui/tooltip';

export const STATUS_STYLE: Record<CellStatus, { variant: NonNullable<BadgeProps['variant']>; label: string; spin?: boolean }> = {
  missing: { variant: 'muted', label: 'pending' },
  blocked: { variant: 'muted', label: 'blocked' },
  skipped: { variant: 'muted', label: 'skipped' },
  queued: { variant: 'blue', label: 'queued' },
  submitting: { variant: 'blue', label: 'submitting', spin: true },
  running: { variant: 'blue', label: 'running', spin: true },
  downloading: { variant: 'violet', label: 'downloading', spin: true },
  succeeded: { variant: 'green', label: 'succeeded' },
  failed: { variant: 'red', label: 'failed' },
  cancelled: { variant: 'muted', label: 'cancelled' },
  unsupported: { variant: 'amber', label: 'unsupported' },
  needs_attention: { variant: 'orange', label: 'needs attention' },
};

export function StatusBadge({
  status,
  tooltip,
  className,
}: {
  status: CellStatus | GenerationStatus;
  tooltip?: string;
  className?: string;
}) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.missing;
  return (
    <WithTooltip label={tooltip}>
      <Badge variant={s.variant} className={className}>
        {s.spin && <Spinner className="size-3 text-current" />}
        {s.label}
      </Badge>
    </WithTooltip>
  );
}
