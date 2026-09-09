import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { CollectionView, CommandInput, CommandName, CommandOutput } from '@imaginator/core';
import { toast } from 'sonner';
import { call, errorMessage } from './client';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const keys = {
  collections: ['collections'] as const,
  collection: (slug: string) => ['collection', slug] as const,
  cell: (address: string) => ['cell', address] as const,
  generation: (ref: string) => ['generation', ref] as const,
  assets: (filters: CommandInput<'assets.list'> = {}) => ['assets', filters] as const,
  models: ['models'] as const,
};

/** Invalidate everything that renders a given collection (list, grid, cells, generations). */
export function invalidateCollection(qc: QueryClient, slug: string): void {
  void qc.invalidateQueries({ queryKey: keys.collection(slug) });
  void qc.invalidateQueries({ queryKey: keys.collections });
  void qc.invalidateQueries({
    predicate: (q) => {
      const [kind, id] = q.queryKey as [string, string | undefined];
      return (kind === 'cell' || kind === 'generation') && typeof id === 'string' && id.startsWith(`${slug}/`);
    },
  });
}

export function invalidateAssets(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['assets'] });
}

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

type QueryOpts<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>;

export function useCollections(opts?: QueryOpts<CommandOutput<'collections.list'>>) {
  return useQuery({
    queryKey: keys.collections,
    queryFn: () => call('collections.list', {}),
    ...opts,
  });
}

export function useCollection(slug: string | undefined, opts?: QueryOpts<CollectionView>) {
  return useQuery({
    queryKey: keys.collection(slug ?? ''),
    queryFn: () => call('collections.get', { collection: slug! }),
    enabled: !!slug,
    ...opts,
  });
}

export function useCell(address: string | undefined) {
  return useQuery({
    queryKey: keys.cell(address ?? ''),
    queryFn: () => call('cells.get', { cell: address! }),
    enabled: !!address,
  });
}

export function useGeneration(ref: string | undefined) {
  return useQuery({
    queryKey: keys.generation(ref ?? ''),
    queryFn: () => call('generations.get', { generation: ref! }),
    enabled: !!ref,
  });
}

export function useAssets(filters: CommandInput<'assets.list'> = {}, opts?: QueryOpts<CommandOutput<'assets.list'>>) {
  return useQuery({
    queryKey: keys.assets(filters),
    queryFn: () => call('assets.list', filters),
    ...opts,
  });
}

export function useModels() {
  return useQuery({
    queryKey: keys.models,
    queryFn: () => call('models.list', {}),
    staleTime: 5 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function isCollectionView(v: unknown): v is CollectionView {
  return !!v && typeof v === 'object' && Array.isArray((v as CollectionView).cells) && typeof (v as CollectionView).slug === 'string';
}

/**
 * What to do with the cache after each command succeeds. Mutations that return
 * a whole `CollectionView` seed the cache directly; the rest invalidate.
 */
function afterSuccess<N extends CommandName>(qc: QueryClient, name: N, input: CommandInput<N>, output: CommandOutput<N>): void {
  const inp = input as Record<string, unknown>;
  const slug = typeof inp.collection === 'string' ? inp.collection : undefined;

  if (isCollectionView(output)) {
    qc.setQueryData(keys.collection(output.slug), output);
    void qc.invalidateQueries({ queryKey: keys.collections });
    if (slug && slug !== output.slug) qc.removeQueries({ queryKey: keys.collection(slug) }); // rename
    // Cells/generations derived from this collection may have changed.
    void qc.invalidateQueries({
      predicate: (q) => {
        const [kind, id] = q.queryKey as [string, string | undefined];
        return (kind === 'cell' || kind === 'generation') && typeof id === 'string' && id.startsWith(`${output.slug}/`);
      },
    });
    return;
  }

  switch (name) {
    case 'collections.delete':
      if (slug) qc.removeQueries({ queryKey: keys.collection(slug) });
      void qc.invalidateQueries({ queryKey: keys.collections });
      return;
    case 'cells.regenerate':
    case 'cells.retry':
    case 'cells.cancel': {
      const cell = typeof inp.cell === 'string' ? inp.cell : '';
      const cellSlug = cell.split('/')[0];
      if (cellSlug) invalidateCollection(qc, cellSlug);
      return;
    }
    case 'assets.upload':
    case 'assets.label':
    case 'assets.gc':
      invalidateAssets(qc);
      return;
    default:
      if (slug) invalidateCollection(qc, slug);
      else void qc.invalidateQueries({ queryKey: keys.collections });
  }
}

type MutationOpts<N extends CommandName> = Omit<
  UseMutationOptions<CommandOutput<N>, Error, CommandInput<N>>,
  'mutationFn'
> & { silent?: boolean };

/** A mutation bound to one command. Errors surface as toasts unless `silent`. */
export function useCommand<N extends CommandName>(name: N, opts: MutationOpts<N> = {}) {
  const qc = useQueryClient();
  const { silent, ...rest } = opts;
  return useMutation<CommandOutput<N>, Error, CommandInput<N>>({
    mutationFn: (input) => call(name, input),
    ...rest,
    onSuccess: (data, variables, context, mutation) => {
      afterSuccess(qc, name, variables, data);
      return rest.onSuccess?.(data, variables, context, mutation);
    },
    onError: (error, variables, context, mutation) => {
      if (!silent) toast.error(errorMessage(error));
      return rest.onError?.(error, variables, context, mutation);
    },
  });
}

/**
 * Imperative variant for places where a hook per command is unwieldy (e.g.
 * drop handlers). Same cache behavior and toasts.
 */
export function useApi() {
  const qc = useQueryClient();
  return async <N extends CommandName>(name: N, input: CommandInput<N>, opts: { silent?: boolean } = {}) => {
    try {
      const out = await call(name, input);
      afterSuccess(qc, name, input, out);
      return out;
    } catch (e) {
      if (!opts.silent) toast.error(errorMessage(e));
      throw e;
    }
  };
}
