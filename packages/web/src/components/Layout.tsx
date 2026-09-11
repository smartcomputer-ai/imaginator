import { NavLink, Outlet } from 'react-router';
import { Images, LayoutGrid, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { logout, useAuthState } from '@/api/auth';
import { errorMessage } from '@/api/client';
import { useConnectionState } from '@/api/events';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WithTooltip } from '@/components/ui/tooltip';

function ConnectionDot() {
  const state = useConnectionState();
  const color =
    state === 'connected' ? 'bg-emerald-500' : state === 'connecting' ? 'bg-amber-400 animate-pulse' : state === 'disconnected' ? 'bg-red-500' : 'bg-muted-foreground/40';
  const label = state === 'connected' ? 'Live updates connected' : state === 'connecting' ? 'Connecting…' : state === 'disconnected' ? 'Disconnected from server' : 'No live subscription';
  return (
    <WithTooltip label={label}>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn('inline-block size-2 rounded-full', color)} />
        {state}
      </span>
    </WithTooltip>
  );
}

function LogoutButton() {
  const auth = useAuthState();
  if (auth.status !== 'ready' || !auth.enabled) return null;
  return (
    <WithTooltip label="Log out">
      <Button variant="ghost" size="iconSm" aria-label="Log out" onClick={() => logout().catch((e: unknown) => toast.error(errorMessage(e)))}>
        <LogOut />
      </Button>
    </WithTooltip>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent',
    isActive ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
  );

export function Layout() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b bg-card px-2">
        <NavLink to="/" className="mr-2 text-[13px] font-semibold tracking-tight">
          Imaginator
        </NavLink>
        <nav className="flex items-center gap-0.5">
          <NavLink to="/" end className={linkClass}>
            <LayoutGrid className="size-3.5" /> Collections
          </NavLink>
          <NavLink to="/assets" className={linkClass}>
            <Images className="size-3.5" /> Assets
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionDot />
          <LogoutButton />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
