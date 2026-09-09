import { useRef, useState } from 'react';
import { assetThumbUrl, INPUT_ROLES, type AssetView, type InputRole } from '@imaginator/core';
import { Upload } from 'lucide-react';
import { useAssets } from '@/api/queries';
import { useUploadFiles } from '@/api/upload';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * Pick an asset from the library (or upload one) and a role. Used by the row
 * header "add input" action.
 */
export function AssetPicker({
  open,
  onOpenChange,
  onPick,
  allowedRoles,
  title = 'Add input',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (asset: AssetView, role: InputRole) => void | Promise<void>;
  allowedRoles?: readonly string[];
  title?: string;
}) {
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState<InputRole>((allowedRoles?.[0] as InputRole) ?? 'reference');
  const [selected, setSelected] = useState<AssetView | undefined>();
  const { data, isLoading } = useAssets({ limit: 200, label: filter.trim() || undefined }, { enabled: open });
  const { upload, uploading } = useUploadFiles();
  const fileRef = useRef<HTMLInputElement>(null);
  const roles = (allowedRoles?.length ? INPUT_ROLES.filter((r) => allowedRoles.includes(r)) : INPUT_ROLES) as InputRole[];

  const finish = async (asset: AssetView) => {
    await onPick(asset, role);
    onOpenChange(false);
    setSelected(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Pick an asset from the library or upload a new one.</DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-2">
          <div className="grid flex-1 gap-1">
            <Label htmlFor="ap-filter">Filter by label</Label>
            <Input id="ap-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="reference-dog" />
          </div>
          <div className="grid w-36 gap-1">
            <Label htmlFor="ap-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as InputRole)}>
              <SelectTrigger id="ap-role">
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
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = e.target.files ? [...e.target.files] : [];
              e.target.value = '';
              const assets = await upload(files);
              if (assets.length === 1) await finish(assets[0]!);
            }}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Spinner /> : <Upload />} Upload
          </Button>
        </div>
        <div
          className="grid max-h-[50vh] min-h-32 grid-cols-6 gap-1.5 overflow-auto rounded-md border p-1.5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const files = [...e.dataTransfer.files];
            const assets = await upload(files);
            if (assets.length === 1) await finish(assets[0]!);
          }}
        >
          {isLoading && (
            <div className="col-span-full flex items-center justify-center py-8">
              <Spinner />
            </div>
          )}
          {data?.assets.map((a) => (
            <button
              key={a.id}
              type="button"
              title={`${a.id}${a.label ? ` · ${a.label}` : ''} · ${a.width}×${a.height}`}
              className={cn(
                'group relative aspect-square overflow-hidden rounded border bg-muted cursor-pointer',
                selected?.id === a.id ? 'ring-2 ring-ring' : 'hover:ring-1 hover:ring-ring/50',
              )}
              onClick={() => setSelected(a)}
              onDoubleClick={() => finish(a)}
            >
              <img src={assetThumbUrl(a.id)} alt={a.label ?? a.id} className="size-full object-cover" loading="lazy" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-[10px] text-white">{a.label ?? a.id}</span>
            </button>
          ))}
          {data && data.assets.length === 0 && !isLoading && (
            <p className="col-span-full py-8 text-center text-xs text-muted-foreground">No assets yet. Upload or drop images here.</p>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">
            {selected ? `${selected.id}${selected.label ? ` · ${selected.label}` : ''}` : 'Select an asset (double-click to add)'}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selected} onClick={() => selected && finish(selected)}>
            Add as {role}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
