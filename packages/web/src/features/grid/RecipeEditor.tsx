import { useState } from 'react';
import { INPUT_ROLES, isRef, type Column, type Input, type InputRole, type ModelInfo } from '@imaginator/core';
import { CornerLeftDown, ImagePlus, Plus, X } from 'lucide-react';
import { AssetPicker } from '@/components/AssetPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input as TextInput } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export const DEFAULT_PROMPT = '{prompt}';
export const DEFAULT_NEGATIVE = '{negativePrompt}';

/** The editable recipe of a column; defaults mean "the row, verbatim". */
export interface RecipeDraft {
  prompt: string;
  negativePrompt: string;
  inputs: Input[] | null;
}

export function recipeDraftOf(column?: Pick<Column, 'prompt' | 'negativePrompt' | 'inputs'>): RecipeDraft {
  return { prompt: column?.prompt ?? DEFAULT_PROMPT, negativePrompt: column?.negativePrompt ?? DEFAULT_NEGATIVE, inputs: column?.inputs ?? null };
}

/** Fields to send on create (omit defaults) or update (null restores defaults). */
export function recipePatch(d: RecipeDraft, mode: 'create'): { prompt?: string; negativePrompt?: string; inputs?: Input[] };
export function recipePatch(d: RecipeDraft, mode: 'update'): { prompt: string | null; negativePrompt: string | null; inputs: Input[] | null };
export function recipePatch(d: RecipeDraft, mode: 'create' | 'update') {
  if (mode === 'create') {
    return {
      ...(d.prompt === DEFAULT_PROMPT ? {} : { prompt: d.prompt }),
      ...(d.negativePrompt === DEFAULT_NEGATIVE ? {} : { negativePrompt: d.negativePrompt }),
      ...(d.inputs === null ? {} : { inputs: d.inputs }),
    };
  }
  return {
    prompt: d.prompt === DEFAULT_PROMPT ? null : d.prompt,
    negativePrompt: d.negativePrompt === DEFAULT_NEGATIVE ? null : d.negativePrompt,
    inputs: d.inputs,
  };
}

/** A replacement list that cannot satisfy the model's minimum inputs (the cells would all be unsupported). */
export function recipeLacksInputs(d: RecipeDraft, model: ModelInfo | undefined): boolean {
  const min = model?.capabilities.minInputImages ?? 0;
  return d.inputs !== null && min > 0 && d.inputs.filter((i) => i.role !== 'mask').length < min;
}

/**
 * "Nothing configured": the row is used as written. For a model without
 * negative prompt support, an empty negative template is the natural default
 * (the only value that keeps its cells supported), so it does not count.
 */
export function isDefaultRecipe(d: RecipeDraft, model?: ModelInfo): boolean {
  const negativeDefault = d.negativePrompt === DEFAULT_NEGATIVE || (d.negativePrompt === '' && model !== undefined && !model.capabilities.negativePrompt);
  return d.prompt === DEFAULT_PROMPT && negativeDefault && d.inputs === null;
}

export function refLabel(i: Extract<Input, { row?: string }>): string {
  return [i.collection, i.row, i.column].filter(Boolean).join('/') + (i.output ? `#${i.output}` : '');
}

/** Columns a recipe reads from (same-row references), for the header marker. */
export function stageSources(column: Pick<Column, 'inputs'>): string[] {
  const out: string[] = [];
  for (const i of column.inputs ?? []) {
    if (isRef(i) && i.column && !i.row && !i.collection && !out.includes(i.column)) out.push(i.column);
  }
  return out;
}

/** A small segmented control; the dialogs use it to keep the model and recipe forms on one screen each. */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: string; hint?: string }> }) {
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-0.5" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          title={t.hint}
          className={cn(
            'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors cursor-pointer',
            value === t.id ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Prompt template, negative prompt template, and inherit-or-replace inputs
 * (DESIGN §3, Column recipes). `self` is the column being edited (excluded
 * from reference targets); `columns` are the other columns of the grid.
 */
export function RecipeEditor({
  value,
  onChange,
  self,
  columns,
  model,
  idPrefix = 'recipe',
}: {
  value: RecipeDraft;
  onChange: (v: RecipeDraft) => void;
  self: string | undefined;
  columns: string[];
  model: ModelInfo | undefined;
  idPrefix?: string;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-[11px] text-muted-foreground">
        How this column builds a cell from the row. Defaults use the row as written; a column that references another column becomes a pipeline stage applied to every row.
      </p>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-prompt`}>Prompt template</Label>
        <TextInput id={`${idPrefix}-prompt`} value={value.prompt} onChange={(e) => onChange({ ...value, prompt: e.target.value })} placeholder="empty prompt (cells will be unsupported)" />
        <p className="text-[11px] text-muted-foreground">{'{prompt}'} is the row's prompt. A literal instruction ("add film grain") ignores it.</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-negative`}>Negative prompt template</Label>
        <TextInput id={`${idPrefix}-negative`} value={value.negativePrompt} onChange={(e) => onChange({ ...value, negativePrompt: e.target.value })} placeholder="empty: no negative prompt" />
        {model && !model.capabilities.negativePrompt ? (
          <p className={cn('text-[11px]', value.negativePrompt === '' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>
            {value.negativePrompt === ''
              ? 'Empty: this model takes no negative prompt, so the row\'s is dropped and cells stay supported.'
              : 'This model takes no negative prompt; any rendered text here makes its cells unsupported. Leave it empty.'}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">Leave empty to drop the row's negative prompt (for example on a stage whose model has none).</p>
        )}
      </div>
      <RecipeInputs value={value.inputs} onChange={(inputs) => onChange({ ...value, inputs })} self={self} columns={columns} model={model} />
    </div>
  );
}

/** Inherit the row's inputs, or replace them with a column-authored list. */
function RecipeInputs({
  value,
  onChange,
  self,
  columns,
  model,
}: {
  value: Input[] | null;
  onChange: (v: Input[] | null) => void;
  self: string | undefined;
  columns: string[];
  model: ModelInfo | undefined;
}) {
  const others = columns.filter((c) => c !== self);
  const [refColumn, setRefColumn] = useState<string>(others[0] ?? '');
  const [role, setRole] = useState<InputRole>('init');
  const [pickerOpen, setPickerOpen] = useState(false);
  const roles = model?.capabilities.inputRoles.length ? INPUT_ROLES.filter((r) => model.capabilities.inputRoles.includes(r)) : INPUT_ROLES;
  const textOnly = model !== undefined && model.capabilities.inputRoles.length === 0;
  const min = model?.capabilities.minInputImages ?? 0;
  const tooFew = min > 0 && (value?.filter((i) => i.role !== 'mask').length ?? 0) < min;

  return (
    <div className="grid gap-1">
      <Label>Inputs</Label>
      <Select
        value={value === null ? 'inherit' : 'replace'}
        onValueChange={(v) => {
          if (v === 'inherit') return onChange(null);
          // A stage almost always reads one column's output: start from the first other column.
          onChange(value ?? (others[0] ? [{ column: others[0], role: roles.includes('init') ? 'init' : roles[0]! }] : []));
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Inherited from the row</SelectItem>
          <SelectItem value="replace">Replaced by this list (pipeline stage)</SelectItem>
        </SelectContent>
      </Select>
      {textOnly && value !== null && <p className="text-[11px] text-amber-700 dark:text-amber-300">This model takes no input images; cells with inputs will be unsupported.</p>}
      {value !== null && tooFew && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          This model edits an image and cannot run without one: add a column output (a pipeline stage) or a frozen asset, or inherit the row's inputs.
        </p>
      )}
      {value === null && min > 0 && (
        <p className="text-[11px] text-muted-foreground">This model needs an input image; rows without one will be unsupported in this column. For a pipeline stage, replace the inputs with another column's output.</p>
      )}
      {value !== null && (
        <div className="grid gap-1 rounded-md border p-2">
          <p className="text-[11px] text-muted-foreground">
            {value.length === 0
              ? 'Nothing here yet. Add what every cell of this column should read: another column\'s output in the same row, or a fixed asset.'
              : 'Each cell reads these, in order. A column output means the current output of that column in the same row.'}
          </p>
          {value.map((inp, i) => (
            <div key={i} className="flex items-center gap-1 text-xs">
              {isRef(inp) ? (
                <Badge variant="violet">
                  <CornerLeftDown className="size-2.5" /> {refLabel(inp)}
                </Badge>
              ) : (
                <Badge variant="outline" className="font-mono">
                  {inp.asset}
                </Badge>
              )}
              <span className="text-muted-foreground">as {inp.role}</span>
              <Button type="button" variant="ghost" size="iconSm" className="ml-auto" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Select value={refColumn} onValueChange={setRefColumn}>
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue placeholder={others.length ? 'column' : 'no other columns'} />
              </SelectTrigger>
              <SelectContent>
                {others.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={role} onValueChange={(v) => setRole(v as InputRole)}>
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!refColumn}
              title="Same row, that column's output"
              onClick={() => onChange([...value, role === 'mask' ? { column: refColumn, role, maskFor: Math.max(0, value.findIndex((x) => x.role === 'init')) } : { column: refColumn, role }])}
            >
              <Plus /> add output of {refColumn || 'column'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <ImagePlus /> asset
            </Button>
          </div>
          <AssetPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            title="Add a fixed asset to the recipe"
            allowedRoles={roles}
            onPick={(asset, r) => onChange([...value, r === 'mask' ? { asset: asset.id, role: r, maskFor: Math.max(0, value.findIndex((x) => x.role === 'init')) } : { asset: asset.id, role: r }])}
          />
        </div>
      )}
    </div>
  );
}
