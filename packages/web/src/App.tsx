import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Layout } from '@/components/Layout';
import { CollectionsPage } from '@/pages/CollectionsPage';
import { GridPage } from '@/pages/GridPage';
import { CellPage } from '@/pages/CellPage';
import { AssetsPage } from '@/pages/AssetsPage';
import { LoginPage } from '@/pages/LoginPage';
import { AuthGate } from '@/components/AuthGate';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <BrowserRouter>
          <AuthGate login={<LoginPage />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<CollectionsPage />} />
                <Route path="/c/:slug" element={<GridPage />} />
                <Route path="/c/:slug/:row/:col" element={<CellPage />} />
                <Route path="/assets" element={<AssetsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </AuthGate>
        </BrowserRouter>
        <Toaster position="bottom-right" richColors closeButton duration={5000} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
