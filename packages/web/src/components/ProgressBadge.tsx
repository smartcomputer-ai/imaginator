import type { Progress, ProgressState } from '@imaginator/core';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { WithTooltip } from '@/components/ui/tooltip';

const STYLE: Record<ProgressState, { variant: 'blue' | 'amber' | 'green' | 'muted'; label: string }> = {
  running: { variant: 'blue', label: 'running' },
  blocked: { variant: 'amber', label: 'blocked' },
  settled: { variant: 'muted', label: 'settled' },
};

/** Dependency-aware progress of a collection (DESIGN §5). */
export function ProgressBadge({ state, progress }: { state: ProgressState; progress?: Progress }) {
  const s = STYLE[state];
  const attention = progress ? progress.attention.failed.length + progress.attention.unsupported.length + progress.attention.needsAttention.length : 0;
  const done = state === 'settled' && progress?.allSucceeded;
  const lines: string[] = [];
  if (progress) {
    if (progress.pendingReconcile) lines.push('reconciling');
    if (progress.upstream.queued + progress.upstream.inFlight > 0) lines.push(`upstream: ${progress.upstream.queued} queued, ${progress.upstream.inFlight} in flight`);
    for (const b of progress.blocked.slice(0, 5)) lines.push(`${b.cell}: ${b.reason}`);
    if (progress.blocked.length > 5) lines.push(`… ${progress.blocked.length - 5} more blocked`);
    for (const f of progress.attention.failed.slice(0, 3)) lines.push(`failed ${f.cell}: ${f.message}`);
    for (const u of progress.attention.unsupported.slice(0, 3)) lines.push(`unsupported ${u.cell}: ${u.message}`);
    for (const n of progress.attention.needsAttention.slice(0, 3)) lines.push(`needs attention ${n.cell}: ${n.message}`);
    for (const a of progress.failedAttempts.slice(0, 3)) lines.push(`failed attempt ${a.cell}: ${a.message}`);
  }
  return (
    <WithTooltip label={lines.length ? lines.join('\n') : done ? 'Every cell has its output' : s.label}>
      <Badge variant={done ? 'green' : s.variant} className="whitespace-pre-line">
        {state === 'running' && <Spinner className="size-2.5 text-current" />}
        {done ? 'complete' : s.label}
        {attention > 0 && <span className="ml-1 opacity-80">· {attention} need attention</span>}
      </Badge>
    </WithTooltip>
  );
}
