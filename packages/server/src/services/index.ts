import { createAssetService } from './assets.js';
import { createCellService } from './cells.js';
import { createCollectionService } from './collections.js';
import { createColumnService } from './columns.js';
import type { ServiceContext } from './context.js';
import { createGenerationService } from './generations.js';
import { reconcileCollectionTx } from './reconcile.js';
import { createRowService } from './rows.js';

export function createServices(ctx: ServiceContext) {
  const generations = createGenerationService(ctx);
  return {
    ctx,
    collections: createCollectionService(ctx),
    columns: createColumnService(ctx),
    rows: createRowService(ctx),
    generations,
    cells: createCellService(ctx, generations),
    assets: createAssetService(ctx),
    reconcile: (slug: string) => reconcileCollectionTx(ctx, slug),
  };
}

export type Services = ReturnType<typeof createServices>;
export type { ServiceContext, EngineHooks } from './context.js';
