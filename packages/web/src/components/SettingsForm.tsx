import type { JsonObject, JsonValue } from '@imaginator/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

/**
 * A minimal JSON-Schema-driven form for model settings. Handles string,
 * number, integer, boolean and enum properties (also when wrapped in
 * anyOf/oneOf with null, as zod's toJSONSchema emits for optional/nullable).
 * Unset keys are omitted so registry defaults apply.
 */

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
};

interface Field {
  key: string;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';
  options?: JsonValue[];
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  required: boolean;
}

function unwrap(s: Schema): Schema {
  // Optional/nullable fields come as anyOf: [X, {type: 'null'}]; pick X.
  const variants = s.anyOf ?? s.oneOf;
  if (variants && variants.length) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    if (nonNull.length === 1) return unwrap({ ...s, ...nonNull[0], anyOf: undefined, oneOf: undefined });
    // A union of consts is an enum.
    if (nonNull.every((v) => v.const !== undefined)) return { ...s, enum: nonNull.map((v) => v.const as JsonValue) };
    if (nonNull.every((v) => v.enum)) return { ...s, enum: nonNull.flatMap((v) => v.enum ?? []) };
  }
  if (s.allOf && s.allOf.length === 1) return unwrap({ ...s, ...s.allOf[0], allOf: undefined });
  return s;
}

export function schemaFields(schema: unknown): Field[] {
  if (!schema || typeof schema !== 'object') return [];
  const root = unwrap(schema as Schema);
  const props = root.properties ?? {};
  const required = new Set(root.required ?? []);
  return Object.entries(props).map(([key, raw]) => {
    const s = unwrap(raw);
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
    const base: Field = { key, kind: 'json', description: s.description, required: required.has(key) };
    if (s.enum && s.enum.length) return { ...base, kind: 'enum', options: s.enum };
    if (type === 'boolean') return { ...base, kind: 'boolean' };
    if (type === 'integer' || type === 'number') {
      const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum : undefined);
      const max = s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum : undefined);
      return { ...base, kind: type, min, max, step: s.multipleOf ?? (type === 'integer' ? 1 : undefined) };
    }
    if (type === 'string') return { ...base, kind: 'string' };
    return base;
  });
}

export function SettingsForm({
  schema,
  defaults,
  value,
  onChange,
}: {
  schema: unknown;
  defaults?: JsonObject;
  value: JsonObject;
  onChange: (next: JsonObject) => void;
}) {
  const fields = schemaFields(schema);
  if (!fields.length) return <p className="text-xs text-muted-foreground">This model has no settings.</p>;

  const set = (key: string, v: JsonValue | undefined) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return (
    <div className="grid gap-2.5">
      {fields.map((f) => {
        const current = value[f.key];
        const def = defaults?.[f.key];
        const placeholder = def === undefined ? '' : String(def);
        return (
          <div key={f.key} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={`setting-${f.key}`}>
                {f.key}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
              {current !== undefined && (
                <button type="button" className="text-[11px] text-muted-foreground hover:underline cursor-pointer" onClick={() => set(f.key, undefined)}>
                  reset
                </button>
              )}
            </div>
            <FieldInput field={f} value={current} placeholder={placeholder} onChange={(v) => set(f.key, v)} />
            {f.description && <p className="text-[11px] text-muted-foreground">{f.description}</p>}
          </div>
        );
      })}
    </div>
  );
}

const UNSET = '__unset__';

function FieldInput({
  field,
  value,
  placeholder,
  onChange,
}: {
  field: Field;
  value: JsonValue | undefined;
  placeholder: string;
  onChange: (v: JsonValue | undefined) => void;
}) {
  const id = `setting-${field.key}`;
  switch (field.kind) {
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} />
          <span className="text-xs text-muted-foreground">{value === undefined ? `default${placeholder ? ` (${placeholder})` : ''}` : String(value)}</span>
        </div>
      );
    case 'enum':
      return (
        <Select value={value === undefined ? UNSET : String(value)} onValueChange={(v) => onChange(v === UNSET ? undefined : (field.options?.find((o) => String(o) === v) ?? v))}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>
              <span className="text-muted-foreground">default{placeholder ? ` (${placeholder})` : ''}</span>
            </SelectItem>
            {(field.options ?? []).map((o) => (
              <SelectItem key={String(o)} value={String(o)}>
                {String(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'number':
    case 'integer':
      return (
        <Input
          id={id}
          type="number"
          inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
          min={field.min}
          max={field.max}
          step={field.step ?? 'any'}
          value={value === undefined ? '' : String(value)}
          placeholder={placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            const n = Number(raw);
            if (Number.isNaN(n)) return;
            onChange(field.kind === 'integer' ? Math.round(n) : n);
          }}
        />
      );
    case 'string':
      return <Input id={id} value={value === undefined ? '' : String(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
    default:
      return (
        <Input
          id={id}
          className="font-mono"
          value={value === undefined ? '' : JSON.stringify(value)}
          placeholder={placeholder || 'JSON'}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            try {
              onChange(JSON.parse(raw) as JsonValue);
            } catch {
              onChange(raw);
            }
          }}
        />
      );
  }
}
