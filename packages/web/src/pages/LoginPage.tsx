import { useState, type FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import { login } from '@/api/auth';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(undefined);
    try {
      await login(password);
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <LockKeyhole className="size-4 text-muted-foreground" />
          <h1 className="text-[15px] font-semibold tracking-tight">Imaginator</h1>
        </div>
        <p className="text-[13px] text-muted-foreground">This server requires a password.</p>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            aria-invalid={!!error}
          />
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={busy || !password}>
          {busy ? <Spinner /> : null}
          Log in
        </Button>
      </form>
    </div>
  );
}
