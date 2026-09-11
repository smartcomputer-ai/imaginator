import { useEffect, useState } from 'react';
import { INPUT_ROLES, type Input, type InputRole } from '@imaginator/core';
import { useCollection, useCollections } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const SAME_COLUMN = '__same__';

/**
 * Pick a live reference for a row input: a row of this or another collection,
 * either "in the same column" (a follow-up chain per model) or one specific
 * column (the same picture for every model). See DESIGN §3, References.
 */
export function ReferencePicker({
  open,
  onOpenChange,
  slug,
  rowId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The collection of the row being edited. */
  slug: string;
  /** The row being edited; it cannot reference itself in the same column. */
  rowId: string;
  onPick: (input: Input) => void | Promise<void>;
}) {
  const [targetSlug, setTargetSlug] = useState(slug);
  const [row, setRow] = useState<string>('');
  const [column, setColumn] = useState<string>(SAME_COLUMN);
  const [role, setRole] = useState<InputRole>('init');
  const collectionsQ = useCollections({ enabled: open });
  const { data: collection } = useCollection(targetSlug, { enabled: open });
  const rows = [...(collection?.rows ?? [])].sort((a, b) => a.position - b.position);
  const columns = [...(collection?.columns ?? [])].sort((a, b) => a.position - b.position);
  const external = targetSlug !== slug;

  useEffect(() => {
    if (open) {
      setTargetSlug(slug);
      setRow('');
      setColumn(SAME_COLUMN);
      setRole('init');
    }
  }, [open, slug]);

  // Another collection has its own columns: a reference into it is always a full address.
  useEffect(() => {
    if (external && column === SAME_COLUMN) setColumn(columns[0]?.id ?? '');
  }, [external, column, columns]);

  const selfRef = !external && row === rowId && column === SAME_COLUMN;
  const valid = row !== '' && (column !== '' || !external) && !selfRef;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a live reference</DialogTitle>
          <DialogDescription>
            The input follows the referenced cell's current output: regenerate or pin it and this row's cells follow. "Same column" makes a follow-up chain
            per model; a specific column feeds that one picture to every model.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>Collection</Label>
            <Select
              value={targetSlug}
              onValueChange={(v) => {
                setTargetSlug(v);
                setRow('');
                setColumn(v === slug ? SAME_COLUMN : '');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(collectionsQ.data?.collections ?? [{ slug }]).map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.slug}
                    {c.slug === slug ? ' (this collection)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Row</Label>
            <Select value={row} onValueChange={setRow}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the row to read from" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="font-mono text-muted-foreground">{r.id}</span> {r.prompt.slice(0, 50) || '(empty)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Column</Label>
            <Select value={column} onValueChange={setColumn}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a column" />
              </SelectTrigger>
              <SelectContent>
                {!external && <SelectItem value={SAME_COLUMN}>Same column (one chain per model)</SelectItem>}
                {columns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.id} <span className="text-muted-foreground">(this picture for every model)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selfRef && <p className="text-[11px] text-destructive">A row cannot reference itself in the same column.</p>}
          </div>
          <div className="grid gap-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as InputRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INPUT_ROLES.filter((r) => r !== 'mask').map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!valid}
            onClick={async () => {
              const input: Input = {
                row,
                ...(column !== SAME_COLUMN ? { column } : {}),
                ...(external ? { collection: targetSlug } : {}),
                role,
              };
              await onPick(input);
              onOpenChange(false);
            }}
          >
            Add reference
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
