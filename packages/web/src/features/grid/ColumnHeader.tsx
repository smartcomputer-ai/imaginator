import { useState } from 'react';
import type { Column, JsonObject, ModelInfo } from '@imaginator/core';
import { ChevronLeft, ChevronRight, Settings2, Trash2 } from 'lucide-react';
import { useCommand } from '@/api/queries';
import { SettingsForm } from '@/components/SettingsForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WithTooltip } from '@/components/ui/tooltip';

export function ColumnHeader({
  slug,
  column,
  model,
  index,
  total,
  order,
  spend,
}: {
  slug: string;
  column: Column;
  model: ModelInfo | undefined;
  index: number;
  total: number;
  order: string[];
  /** Estimated USD of the column's current generations, when any cell reports a cost. */
  spend?: number;
}) {
  const remove = useCommand('columns.remove');
  const reorder = useCommand('columns.reorder');
  const [open, setOpen] = useState(false);

  const move = (delta: number) => {
    const next = [...order];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    reorder.mutate({ collection: slug, order: next });
  };

  const settingCount = Object.keys(column.settings ?? {}).length;

  return (
    <div className="group flex h-full min-w-0 flex-col gap-0.5 px-1 py-1 text-left">
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-[12px] font-semibold" title={column.id}>
          {column.id}
        </span>
        {column.count > 1 && (
          <WithTooltip label={`${column.count} outputs per cell`}>
            <Badge variant="secondary">×{column.count}</Badge>
          </WithTooltip>
        )}
        {spend !== undefined && (
          <WithTooltip label={`Estimated spend on this column's current cells${model?.pricing ? `. ${model.pricing}` : ''}`}>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatUsd(spend)}</span>
          </WithTooltip>
        )}
        <div className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <WithTooltip label="Move left">
            <Button variant="ghost" size="iconSm" disabled={index === 0 || reorder.isPending} onClick={() => move(-1)}>
              <ChevronLeft />
            </Button>
          </WithTooltip>
          <WithTooltip label="Move right">
            <Button variant="ghost" size="iconSm" disabled={index === total - 1 || reorder.isPending} onClick={() => move(1)}>
              <ChevronRight />
            </Button>
          </WithTooltip>
          <WithTooltip label="Remove column">
            <Button
              variant="ghost"
              size="iconSm"
              className="hover:text-destructive"
              onClick={() => {
                if (window.confirm(`Remove column "${column.id}" and its generations?`)) remove.mutate({ collection: slug, column: column.id });
              }}
            >
              <Trash2 />
            </Button>
          </WithTooltip>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={column.model}>
          {model ? model.name : column.model}
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="iconSm" className="ml-auto shrink-0 text-muted-foreground">
              <Settings2 />
              {settingCount > 0 && <span className="text-[10px]">{settingCount}</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            {open && <ColumnSettings slug={slug} column={column} model={model} onDone={() => setOpen(false)} />}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

export function formatUsd(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function ColumnSettings({ slug, column, model, onDone }: { slug: string; column: Column; model: ModelInfo | undefined; onDone: () => void }) {
  const [id, setId] = useState(column.id);
  const [count, setCount] = useState(String(column.count));
  const [settings, setSettings] = useState<JsonObject>(column.settings ?? {});
  const update = useCommand('columns.update', { onSuccess: onDone });
  const maxCount = model?.capabilities.count;

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Math.max(1, Math.round(Number(count) || 1));
        update.mutate({
          collection: slug,
          column: column.id,
          id: id !== column.id ? id : undefined,
          count: n,
          settings: Object.keys(settings).length ? settings : null,
        });
      }}
    >
      <div className="text-xs text-muted-foreground">
        <span className="font-mono">{column.model}</span>
        {model && (
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline">{model.capabilities.inputRoles.length ? `inputs: ${model.capabilities.inputRoles.join(', ')}` : 'text only'}</Badge>
            {model.capabilities.negativePrompt && <Badge variant="outline">negative prompt</Badge>}
            <Badge variant="outline">honors: {model.capabilities.commonKeys.join(', ') || 'none'}</Badge>
          </div>
        )}
        {model?.pricing && <div className="mt-1 tabular-nums">{model.pricing}</div>}
      </div>
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div className="grid gap-1">
          <Label htmlFor="col-id">Column id</Label>
          <Input id="col-id" className="font-mono" value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="col-count">Count{maxCount ? ` ≤${maxCount}` : ''}</Label>
          <Input id="col-count" type="number" min={1} max={maxCount} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1">
        <Label>Model settings</Label>
        <SettingsForm schema={model?.settingsSchema} defaults={model?.settingsDefaults} value={settings} onChange={setSettings} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
