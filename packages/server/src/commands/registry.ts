import { z } from 'zod';
import {
  commandDefs,
  commandNames,
  providerIdOf,
  type CommandDef,
  type CommandName,
  type CommandOutput,
  type CommandParsedInput,
  type ModelInfo,
  type ModelRegistry,
} from '@imaginator/core';
import { ServiceError } from '../errors.js';
import type { Services } from '../services/index.js';

export interface Command<N extends CommandName = CommandName> extends CommandDef<N, (typeof commandDefs)[N]['input'], (typeof commandDefs)[N]['output']> {
  /** Validate `input` against the zod schema and execute. */
  run(input: unknown): Promise<CommandOutput<N>>;
}

export type CommandRegistry = { [N in CommandName]: Command<N> };

type Handlers = { [N in CommandName]: (input: CommandParsedInput<N>) => Promise<CommandOutput<N>> | CommandOutput<N> };

function modelInfo(registry: ModelRegistry): ModelInfo[] {
  return registry.list().map((spec) => {
    let settingsSchema: unknown = {};
    try {
      settingsSchema = z.toJSONSchema(spec.settings, { unrepresentable: 'any' });
    } catch {
      settingsSchema = { type: 'object' };
    }
    return {
      id: spec.id,
      name: spec.name,
      provider: providerIdOf(spec.id),
      kind: spec.kind,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      capabilities: { ...spec.capabilities },
      settingsSchema: settingsSchema as ModelInfo['settingsSchema'],
      settingsDefaults: registry.defaultsFor(spec.id) as ModelInfo['settingsDefaults'],
    };
  });
}

export function createHandlers(services: Services, registry: ModelRegistry): Handlers {
  const { collections, columns, rows, cells, generations, assets } = services;
  return {
    'models.list': () => ({ models: modelInfo(registry), registryVersion: registry.version }),

    'collections.list': () => ({ collections: collections.list() }),
    'collections.get': (i) => collections.get(i.collection),
    'collections.create': (i) => collections.create(i),
    'collections.update': (i) => collections.update(i.collection, i),
    'collections.delete': (i) => collections.delete(i.collection),
    'collections.pause': (i) => collections.setStatus(i.collection, 'paused'),
    'collections.resume': (i) => collections.setStatus(i.collection, 'live'),
    'collections.duplicate': (i) => collections.duplicate(i.collection, i.slug, i),
    'collections.rename': (i) => collections.rename(i.collection, i.slug),
    'collections.export': (i) => ({ document: collections.export(i.collection) }),
    'collections.import': (i) => collections.import(i.document, i),
    'collections.wait': (i) => collections.wait(i.collection, i.cursor, i.timeoutMs),

    'columns.add': (i) => columns.add(i.collection, i),
    'columns.update': (i) => columns.update(i.collection, i.column, i),
    'columns.remove': (i) => columns.remove(i.collection, i.column),
    'columns.reorder': (i) => columns.reorder(i.collection, i.order),

    'rows.add': (i) => rows.add(i.collection, i.rows),
    'rows.update': (i) => rows.update(i.collection, i.row, i),
    'rows.remove': (i) => rows.remove(i.collection, i.rows),
    'rows.reorder': (i) => rows.reorder(i.collection, i.order),
    'rows.pause': (i) => rows.pause(i.collection, i.rows),
    'rows.resume': (i) => rows.resume(i.collection, i.rows),
    'rows.duplicate': (i) => rows.duplicate(i.collection, i.row),

    'cells.get': (i) => cells.get(i.cell),
    'cells.regenerate': (i) => cells.regenerate(i.cell),
    'cells.retry': (i) => cells.retry(i.cell),
    'cells.cancel': (i) => cells.cancel(i.cell),

    'generations.get': (i) => ({ generation: generations.get(i.generation) }),

    'assets.upload': async (i) => ({ asset: await assets.upload(i) }),
    'assets.get': (i) => ({ asset: assets.get(i.asset) }),
    'assets.list': (i) => assets.list(i),
    'assets.label': (i) => ({ asset: assets.label(i.asset, i.label) }),
    'assets.gc': (i) => assets.gc(i.dryRun ?? false),
  };
}

/** Attach `run()` to every core `CommandDef`. */
export function createCommandRegistry(services: Services, registry: ModelRegistry): CommandRegistry {
  const handlers = createHandlers(services, registry);
  const out: Partial<CommandRegistry> = {};
  for (const name of commandNames) {
    const def = commandDefs[name];
    const handler = handlers[name] as (input: unknown) => unknown;
    const command = {
      ...def,
      async run(input: unknown) {
        const parsed = def.input.safeParse(input ?? {});
        if (!parsed.success) throw new ServiceError('validation', `invalid input for ${name}`, parsed.error.issues);
        return await handler(parsed.data);
      },
    };
    (out as Record<string, unknown>)[name] = command;
  }
  return out as CommandRegistry;
}
