import type { Provider } from '@imaginator/core';
import type { ServerConfig } from '../config.js';
import { mockProvider } from './mock.js';
import { createFalProvider } from './fal.js';
import { createOpenAIProvider } from './openai.js';

/**
 * Build the enabled providers. Real adapters register here: a provider is
 * enabled when `config.providers[id].apiKey` is present.
 */
export function buildProviders(config: ServerConfig): Provider[] {
  const providers: Provider[] = [];
  if (config.mock) providers.push(mockProvider);
  const openai = config.providers.openai;
  if (openai?.apiKey) {
    providers.push(
      createOpenAIProvider({
        apiKey: openai.apiKey,
        ...(openai.concurrency !== undefined ? { concurrency: openai.concurrency } : {}),
        ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
      }),
    );
  }
  const fal = config.providers.fal;
  if (fal?.apiKey) {
    providers.push(createFalProvider({ apiKey: fal.apiKey, ...(fal.concurrency !== undefined ? { concurrency: fal.concurrency } : {}) }));
  }
  return providers;
}

export { mockControl, mockProvider } from './mock.js';
export { createOpenAIProvider, OPENAI_MODELS } from './openai.js';
export { createFalProvider, FAL_MODELS } from './fal.js';
