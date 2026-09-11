import { useEffect, useMemo, useState } from 'react';
import { slugify, type JsonObject, type ModelInfo } from '@imaginator/core';
import { useCommand, useModels } from '@/api/queries';
import { SettingsForm } from '@/components/SettingsForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { DEFAULT_NEGATIVE, RecipeEditor, Tabs, isDefaultRecipe, recipeDraftOf, recipeLacksInputs, recipePatch, type RecipeDraft } from './RecipeEditor';

export function AddColumnDialog({ slug, open, onOpenChange, existingIds }: { slug: string; open: boolean; onOpenChange: (o: boolean) => void; existingIds: string[] }) {
  const models = useModels();
  const [modelId, setModelId] = useState<string | undefined>();
  const [id, setId] = useState('');
  const [count, setCount] = useState('1');
  const [settings, setSettings] = useState<JsonObject>({});
  const [recipe, setRecipe] = useState<RecipeDraft>(() => recipeDraftOf());
  const [tab, setTab] = useState<'model' | 'recipe'>('model');
  const add = useCommand('columns.add', { onSuccess: () => onOpenChange(false) });

  useEffect(() => {
    if (open) {
      setModelId(undefined);
      setId('');
      setCount('1');
      setSettings({});
      setRecipe(recipeDraftOf());
      setTab('model');
    }
  }, [open]);

  const grouped = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models.data?.models ?? []) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models.data]);

  const model = models.data?.models.find((m) => m.id === modelId);
  const shortName = modelId ? slugify(modelId.slice(modelId.indexOf('/') + 1)) || 'column' : '';
  const suggestedId = useMemo(() => {
    if (!shortName) return '';
    let candidate = shortName;
    let n = 2;
    while (existingIds.includes(candidate)) candidate = `${shortName}-${n++}`;
    return candidate;
  }, [shortName, existingIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add column</DialogTitle>
          <DialogDescription>Pick a model; every row gets a new cell for it. Set the recipe here too if the column is a pipeline stage, so nothing runs with the wrong inputs first.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!modelId) return;
            const n = Math.max(1, Math.round(Number(count) || 1));
            add.mutate({
              collection: slug,
              model: modelId,
              id: (id.trim() || suggestedId) || undefined,
              count: n,
              settings: Object.keys(settings).length ? settings : undefined,
              ...recipePatch(recipe, 'create'),
            });
          }}
        >
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            {models.isLoading && (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            )}
            {models.error && <p className="p-3 text-xs text-destructive">{models.error.message}</p>}
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div className="sticky top-0 border-b bg-muted px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{provider}</div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={cn(
                      'flex w-full flex-col gap-0.5 border-b px-2 py-1.5 text-left hover:bg-accent/60 cursor-pointer',
                      modelId === m.id && 'bg-accent',
                    )}
                    onClick={() => {
                      setModelId(m.id);
                      setSettings({});
                      // A model without negative prompts would turn every cell unsupported if it inherited the row's;
                      // default to dropping it, unless the user typed a template of their own.
                      setRecipe((r) => {
                        const untouched = r.negativePrompt === DEFAULT_NEGATIVE || r.negativePrompt === '';
                        return untouched ? { ...r, negativePrompt: m.capabilities.negativePrompt ? DEFAULT_NEGATIVE : '' } : r;
                      });
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{m.id}</span>
                      {m.kind === 'video' && <Badge variant="violet">video</Badge>}
                    </div>
                    {m.description && <div className="text-xs text-muted-foreground">{m.description}</div>}
                    {m.pricing && <div className="text-[11px] tabular-nums text-muted-foreground">{m.pricing}</div>}
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{m.capabilities.inputRoles.length ? `inputs: ${m.capabilities.inputRoles.join(', ')} (≤${m.capabilities.maxInputImages})` : 'text only'}</Badge>
                      {m.capabilities.negativePrompt && <Badge variant="outline">neg prompt</Badge>}
                      {m.capabilities.count > 1 && <Badge variant="outline">count ≤{m.capabilities.count}</Badge>}
                      <Badge variant="outline">{m.capabilities.commonKeys.join(', ') || 'no common keys'}</Badge>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="grid max-h-[60vh] content-start gap-3 overflow-auto pr-1">
            {!model ? (
              <p className="text-sm text-muted-foreground">Select a model on the left.</p>
            ) : (
              <>
                <Tabs
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: 'model', label: 'Model', hint: 'Id, count, model settings' },
                    { id: 'recipe', label: isDefaultRecipe(recipe, model) ? 'Recipe' : 'Recipe •', hint: 'Prompt template and inputs: pipeline stages' },
                  ]}
                />
                {tab === 'recipe' ? (
                  <div className="max-h-[52vh] overflow-auto pr-1">
                    <RecipeEditor value={recipe} onChange={setRecipe} self={id.trim() || suggestedId} columns={existingIds} model={model} idPrefix="ac-recipe" />
                  </div>
                ) : (
                <>
                <div className="grid grid-cols-[1fr_5rem] gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="ac-id">Column id</Label>
                    <Input id="ac-id" className="font-mono" value={id} placeholder={suggestedId} onChange={(e) => setId(e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="ac-count">Count ≤{model.capabilities.count}</Label>
                    <Input id="ac-count" type="number" min={1} max={model.capabilities.count} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
                  </div>
                </div>
                {model.capabilities.aspectRatios && (
                  <p className="text-[11px] text-muted-foreground">Aspect ratios: {model.capabilities.aspectRatios.join(', ')}</p>
                )}
                {model.capabilities.sizes && <p className="text-[11px] text-muted-foreground">Sizes: {model.capabilities.sizes.join(', ')}</p>}
                <div className="grid gap-1">
                  <Label>Model settings</Label>
                  <div className="max-h-[38vh] overflow-auto pr-1">
                    <SettingsForm schema={model.settingsSchema} defaults={model.settingsDefaults} value={settings} onChange={setSettings} />
                  </div>
                </div>
                </>
                )}
              </>
            )}
          </div>
        </div>
        <DialogFooter className="border-t pt-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!model || add.isPending || recipeLacksInputs(recipe, model)} title={recipeLacksInputs(recipe, model) ? 'The recipe replaces the inputs with an empty list, but this model needs an image' : undefined}>
            {add.isPending && <Spinner className="text-current" />}
            Add column
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
