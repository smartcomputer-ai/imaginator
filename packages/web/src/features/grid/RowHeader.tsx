import { useState } from 'react';
import { assetThumbUrl, INPUT_ROLES, type CommonSettings, type Input as RowInputRef, type InputRole, type Row } from '@imaginator/core';
import { ChevronDown, ChevronUp, Copy, ImagePlus, MoreHorizontal, Pause, Play, Settings2, StickyNote, Trash2, X } from 'lucide-react';
import { useApi, useCommand } from '@/api/queries';
import { extractDropPayload, useUploadFiles } from '@/api/upload';
import { AssetPicker } from '@/components/AssetPicker';
import { CommonSettingsForm } from '@/components/CommonSettingsForm';
import { InlineTextarea } from '@/components/InlineEdit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const ROLE_STYLE: Record<InputRole, 'blue' | 'violet' | 'amber'> = { reference: 'blue', init: 'violet', mask: 'amber' };

export function RowHeader({
  slug,
  row,
  defaults,
  index,
  total,
  order,
}: {
  slug: string;
  row: Row;
  defaults: CommonSettings;
  index: number;
  total: number;
  order: string[];
}) {
  const api = useApi();
  const update = useCommand('rows.update');
  const pause = useCommand('rows.pause');
  const resume = useCommand('rows.resume');
  const duplicate = useCommand('rows.duplicate');
  const remove = useCommand('rows.remove');
  const reorder = useCommand('rows.reorder');
  const { upload, uploading } = useUploadFiles();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showNegative, setShowNegative] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const setInputs = (inputs: RowInputRef[]) => update.mutate({ collection: slug, row: row.id, inputs });
  const appendAssets = (ids: string[], role: InputRole = 'reference') => {
    if (!ids.length) return;
    const add: RowInputRef[] = ids.map((asset) => (role === 'mask' ? { asset, role, maskFor: Math.max(0, row.inputs.findIndex((i) => i.role === 'init')) } : { asset, role }));
    setInputs([...row.inputs, ...add]);
  };
  const removeInput = (i: number) => {
    const next = row.inputs.filter((_, j) => j !== i).map((inp) => {
      if (inp.role !== 'mask' || inp.maskFor === undefined) return inp;
      // Keep mask targets pointing at the same init input after removal.
      const maskFor = inp.maskFor > i ? inp.maskFor - 1 : inp.maskFor;
      return { ...inp, maskFor };
    });
    setInputs(next);
  };
  const setRole = (i: number, role: InputRole) => {
    const next = row.inputs.map((inp, j) => {
      if (j !== i) return inp;
      if (role === 'mask') {
        const target = row.inputs.findIndex((x, k) => k !== i && x.role === 'init');
        return { asset: inp.asset, role, maskFor: Math.max(0, target) };
      }
      return { asset: inp.asset, role };
    });
    setInputs(next);
  };

  const move = (delta: number) => {
    const next = [...order];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    reorder.mutate({ collection: slug, order: next });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const { files, assetId } = extractDropPayload(e.dataTransfer);
    if (assetId) return appendAssets([assetId]);
    if (files.length) {
      const assets = await upload(files);
      appendAssets(assets.map((a) => a.id));
    }
  };
  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const assets = await upload(files);
    appendAssets(assets.map((a) => a.id));
  };

  const hasSettings = row.settings && Object.keys(row.settings).length > 0;
  const negativeVisible = showNegative || !!row.negativePrompt;
  const notesVisible = showNotes || !!row.notes;

  return (
    <div
      className={cn('group/row flex h-full flex-col gap-1 px-1.5 py-1', dragOver && 'rounded bg-accent/60 ring-1 ring-ring', row.paused && 'opacity-70')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11px] text-muted-foreground">{row.id}</span>
        {row.paused && <Badge variant="muted">paused</Badge>}
        {hasSettings && (
          <WithTooltip label={JSON.stringify(row.settings)}>
            <Badge variant="outline">settings</Badge>
          </WithTooltip>
        )}
        <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
          <WithTooltip label={row.paused ? 'Resume row' : 'Pause row'}>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => (row.paused ? resume.mutate({ collection: slug, rows: [row.id] }) : pause.mutate({ collection: slug, rows: [row.id] }))}
            >
              {row.paused ? <Play /> : <Pause />}
            </Button>
          </WithTooltip>
          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="iconSm" title="Row settings">
                <Settings2 />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <p className="mb-2 text-xs text-muted-foreground">Common settings for this row. Empty fields inherit the collection defaults.</p>
              {settingsOpen && (
                <CommonSettingsForm
                  value={row.settings}
                  inherited={defaults}
                  saving={update.isPending}
                  onSave={(settings) => {
                    update.mutate({ collection: slug, row: row.id, settings: Object.keys(settings).length ? settings : null }, { onSuccess: () => setSettingsOpen(false) });
                  }}
                  onClear={() => update.mutate({ collection: slug, row: row.id, settings: null }, { onSuccess: () => setSettingsOpen(false) })}
                />
              )}
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="iconSm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => duplicate.mutate({ collection: slug, row: row.id })}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowNegative(true)}>
                <X /> Negative prompt
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowNotes(true)}>
                <StickyNote /> Notes
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                <ImagePlus /> Add input…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={index === 0} onSelect={() => move(-1)}>
                <ChevronUp /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === total - 1} onSelect={() => move(1)}>
                <ChevronDown /> Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  if (window.confirm(`Remove row ${row.id} and its generations?`)) remove.mutate({ collection: slug, rows: [row.id] });
                }}
              >
                <Trash2 /> Remove row
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <InlineTextarea
        value={row.prompt}
        placeholder="Prompt…"
        maxRows={4}
        saveNote="changes regenerate this row"
        onCommit={(prompt) => update.mutate({ collection: slug, row: row.id, prompt })}
      />

      {negativeVisible && (
        <div className="flex items-start gap-1">
          <span className="mt-1 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">neg</span>
          <InlineTextarea
            value={row.negativePrompt ?? ''}
            placeholder="Negative prompt…"
            rows={1}
            maxRows={2}
            saveNote="changes regenerate this row"
            autoFocus={showNegative && !row.negativePrompt}
            className="text-xs text-muted-foreground"
            onCommit={(v) => {
              update.mutate({ collection: slug, row: row.id, negativePrompt: v.trim() ? v : null });
              if (!v.trim()) setShowNegative(false);
            }}
          />
        </div>
      )}

      {notesVisible && (
        <div className="flex items-start gap-1">
          <StickyNote className="mt-1 size-3 shrink-0 text-muted-foreground" />
          <InlineTextarea
            value={row.notes ?? ''}
            placeholder="Notes (not part of the request)"
            rows={1}
            maxRows={2}
            saveNote="notes never regenerate anything"
            autoFocus={showNotes && !row.notes}
            className="text-xs italic text-muted-foreground"
            onCommit={(v) => {
              update.mutate({ collection: slug, row: row.id, notes: v.trim() ? v : null });
              if (!v.trim()) setShowNotes(false);
            }}
          />
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1 pt-0.5">
        {row.inputs.map((inp, i) => (
          <div key={`${inp.asset}-${i}`} className="group/input relative size-10 overflow-hidden rounded border bg-muted" title={`${inp.asset} · ${inp.role}${inp.maskFor !== undefined ? ` for #${inp.maskFor}` : ''}`}>
            <img src={assetThumbUrl(inp.asset)} alt={inp.asset} className="size-full object-cover" loading="lazy" draggable={false} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="absolute inset-x-0 bottom-0 cursor-pointer">
                  <Badge variant={ROLE_STYLE[inp.role]} className="w-full justify-center rounded-none px-0 py-px text-[9px]">
                    {inp.role}
                    {inp.role === 'mask' && inp.maskFor !== undefined ? `→${inp.maskFor}` : ''}
                  </Badge>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {INPUT_ROLES.map((r) => (
                  <DropdownMenuItem key={r} disabled={r === inp.role} onSelect={() => setRole(i, r)}>
                    {r}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              className="absolute right-0 top-0 hidden rounded-bl bg-black/60 p-px text-white group-hover/input:block cursor-pointer"
              title="Remove input"
              onClick={() => removeInput(i)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <WithTooltip label="Add input image (or paste / drop onto the row)">
          <Button variant="outline" size="iconSm" className="size-10 text-muted-foreground" onClick={() => setPickerOpen(true)} disabled={uploading}>
            {uploading ? <Spinner /> : <ImagePlus />}
          </Button>
        </WithTooltip>
      </div>

      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (asset, role) => {
          const add: RowInputRef = role === 'mask' ? { asset: asset.id, role, maskFor: Math.max(0, row.inputs.findIndex((i) => i.role === 'init')) } : { asset: asset.id, role };
          await api('rows.update', { collection: slug, row: row.id, inputs: [...row.inputs, add] });
        }}
      />
    </div>
  );
}
