import type { ModelSpec, Provider } from './provider.js';
import type { ModelId } from './ids.js';

/**
 * Static registry of models, built from the enabled providers. `version`
 * is recorded on every generation's request snapshot (never hashed).
 */
export class ModelRegistry {
  readonly version: string;
  private readonly specs = new Map<ModelId, ModelSpec>();
  private readonly providers = new Map<string, Provider>();

  constructor(providers: Provider[], version: string) {
    this.version = version;
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`);
      this.providers.set(provider.id, provider);
      for (const spec of provider.models) {
        if (!spec.id.startsWith(`${provider.id}/`)) {
          throw new Error(`model ${spec.id} must be prefixed with its provider id ${provider.id}/`);
        }
        if (this.specs.has(spec.id)) throw new Error(`duplicate model id: ${spec.id}`);
        this.specs.set(spec.id, spec);
      }
    }
  }

  get(id: ModelId): ModelSpec | undefined {
    return this.specs.get(id);
  }

  has(id: ModelId): boolean {
    return this.specs.has(id);
  }

  list(): ModelSpec[] {
    return [...this.specs.values()];
  }

  provider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  providerFor(modelId: ModelId): Provider | undefined {
    return this.providers.get(modelId.slice(0, modelId.indexOf('/')));
  }

  listProviders(): Provider[] {
    return [...this.providers.values()];
  }

  /** Registry defaults for a model: its settings schema parsed against `{}`. */
  defaultsFor(id: ModelId): Record<string, unknown> {
    const spec = this.specs.get(id);
    if (!spec) return {};
    const parsed = spec.settings.safeParse({});
    return parsed.success ? (parsed.data as Record<string, unknown>) : {};
  }
}
