import { useState } from 'react';
import { INPUT_ROLES, type InputRole } from '@imaginator/core';
import { useApi, useCollection, useCollections } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

/** Append an asset to a row's inputs: choose collection → row → role. */
export function AddToRowDialog({
  assetId,
  open,
  onOpenChange,
  defaultCollection,
}: {
  assetId: string | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultCollection?: string;
}) {
  const api = useApi();
  const collections = useCollections({ enabled: open });
  const [slug, setSlug] = useState<string | undefined>(defaultCollection);
  const [rowId, setRowId] = useState<string | undefined>();
  const [role, setRole] = useState<InputRole>('reference');
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slug ?? defaultCollection ?? collections.data?.collections[0]?.slug;
  const collection = useCollection(effectiveSlug, { enabled: open && !!effectiveSlug });
  const rows = [...(collection.data?.rows ?? [])].sort((a, b) => a.position - b.position);
  const row = rows.find((r) => r.id === rowId) ?? rows[0];

  const submit = async () => {
    if (!assetId || !effectiveSlug || !row) return;
    setBusy(true);
    try {
      const input = role === 'mask' ? { asset: assetId, role, maskFor: Math.max(0, row.inputs.findIndex((i) => i.role === 'init')) } : { asset: assetId, role };
      await api('rows.update', { collection: effectiveSlug, row: row.id, inputs: [...row.inputs, input] });
      toast.success(`Added ${assetId} to ${effectiveSlug}/${row.id} as ${role}`);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {assetId} to a row</DialogTitle>
          <DialogDescription>The asset is appended to the row's inputs with the chosen role.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5">
          <div className="grid gap-1">
            <Label>Collection</Label>
            <Select value={effectiveSlug ?? ''} onValueChange={(v) => { setSlug(v); setRowId(undefined); }}>
              <SelectTrigger>
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {collections.data?.collections.map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.title} <span className="text-muted-foreground">({c.slug})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Row</Label>
            <Select value={row?.id ?? ''} onValueChange={setRowId} disabled={!rows.length}>
              <SelectTrigger>
                <SelectValue placeholder={rows.length ? 'Choose…' : 'No rows'} />
              </SelectTrigger>
              <SelectContent>
                {rows.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="font-mono text-muted-foreground">{r.id}</span> {r.prompt.slice(0, 60) || '(empty prompt)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as InputRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INPUT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!row || busy}>
            Add input
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
