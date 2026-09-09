import { useState } from 'react';
import { OUTPUT_FORMATS, commonSettingsSchema, type CommonSettings } from '@imaginator/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

const UNSET = '__unset__';

/**
 * Editor for CommonSettings (aspectRatio, size, seed, outputFormat). Local
 * draft state; `onSave` receives a validated object. Empty fields are omitted.
 */
export function CommonSettingsForm({
  value,
  inherited,
  onSave,
  onClear,
  saving,
}: {
  value: CommonSettings | undefined;
  /** Values that apply when this level leaves a key unset (e.g. collection defaults for a row). */
  inherited?: CommonSettings;
  onSave: (next: CommonSettings) => void;
  onClear?: () => void;
  saving?: boolean;
}) {
  const [aspectRatio, setAspectRatio] = useState(value?.aspectRatio ?? '');
  const [size, setSize] = useState(value?.size ?? '');
  const [seed, setSeed] = useState(value?.seed === undefined ? '' : String(value.seed));
  const [outputFormat, setOutputFormat] = useState<string>(value?.outputFormat ?? UNSET);
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    const draft: Record<string, unknown> = {};
    if (aspectRatio.trim()) draft.aspectRatio = aspectRatio.trim();
    if (size.trim()) draft.size = size.trim();
    if (seed.trim()) draft.seed = Number(seed);
    if (outputFormat !== UNSET) draft.outputFormat = outputFormat;
    const parsed = commonSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    setError(undefined);
    onSave(parsed.data);
  };

  return (
    <form
      className="grid gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label htmlFor="cs-aspect">aspectRatio</Label>
          <Input id="cs-aspect" value={aspectRatio} placeholder={inherited?.aspectRatio ?? '16:9'} onChange={(e) => setAspectRatio(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="cs-size">size</Label>
          <Input id="cs-size" value={size} placeholder={inherited?.size ?? '1024x1024'} onChange={(e) => setSize(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="cs-seed">seed</Label>
          <Input id="cs-seed" type="number" min={0} step={1} value={seed} placeholder={inherited?.seed === undefined ? 'random' : String(inherited.seed)} onChange={(e) => setSeed(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="cs-format">outputFormat</Label>
          <Select value={outputFormat} onValueChange={setOutputFormat}>
            <SelectTrigger id="cs-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>
                <span className="text-muted-foreground">{inherited?.outputFormat ? `default (${inherited.outputFormat})` : 'default'}</span>
              </SelectItem>
              {OUTPUT_FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-between gap-2">
        {onClear ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={saving}>
            Clear overrides
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}
