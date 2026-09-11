import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/api/auth';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * Renders the app only when the server is open or this browser holds a
 * session. On a server with AUTH_ENABLED it shows the login page first and
 * again whenever a request comes back 401 (expired session, logout).
 */
export function AuthGate({ login, children }: { login: ReactNode; children: ReactNode }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const authenticated = auth.status === 'ready' && (!auth.enabled || auth.authenticated);
  const wasAuthenticated = useRef(false);

  // Queries that failed with 401 while logged out are stale: refetch after a login.
  useEffect(() => {
    if (authenticated && !wasAuthenticated.current) void qc.invalidateQueries();
    wasAuthenticated.current = authenticated;
  }, [authenticated, qc]);

  if (auth.status === 'loading') {
    if (auth.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-[13px] text-muted-foreground">
          <p>Cannot reach the server: {auth.error}</p>
          <Button variant="outline" size="sm" onClick={auth.retry}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!authenticated) return <>{login}</>;
  return <>{children}</>;
}
