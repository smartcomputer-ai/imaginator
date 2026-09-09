// Re-exports kept separate so resolve.ts reads cleanly.
export type { Asset, Column, Row, ResolvedRequest } from './domain.js';
export type CommonSettingsLike = { aspectRatio?: string; size?: string; seed?: number; outputFormat?: string };
