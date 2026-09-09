import { useEffect, useState } from 'react';
import { useCommand } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export function AddRowDialog({ slug, open, onOpenChange }: { slug: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [prompt, setPrompt] = useState('');
  const [bulk, setBulk] = useState(false);
  const add = useCommand('rows.add', {
    onSuccess: () => {
      setPrompt('');
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (open) setPrompt('');
  }, [open]);

  const submit = () => {
    const prompts = bulk ? prompt.split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean) : [prompt.trim()];
    if (!prompts.length || !prompts[0]) return;
    add.mutate({ collection: slug, rows: prompts.map((p) => ({ prompt: p })) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add row</DialogTitle>
          <DialogDescription>Enter adds the row; Shift+Enter inserts a newline.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="ar-prompt">Prompt</Label>
          <Textarea
            id="ar-prompt"
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="A neon cat riding a bicycle through Tokyo at night"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="ar-bulk" checked={bulk} onCheckedChange={setBulk} />
          <Label htmlFor="ar-bulk" className="cursor-pointer">
            Bulk: one row per line
          </Label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!prompt.trim() || add.isPending}>
            {add.isPending && <Spinner className="text-current" />}
            Add {bulk ? 'rows' : 'row'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
