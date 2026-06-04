// Metadata context — public surface.
// TMDB enrichment provider, normalized metadata types, refresh worker, and HTTP adapter.
export type { MovieMetadata, ShowMetadata, EpisodeMetadata, Metadata, Person } from './domain/metadata.ts'
export { createTmdbProvider, type TmdbProvider } from './infrastructure/tmdb/tmdb.ts'
export { imageCachePath, fileExists } from './infrastructure/tmdb/cache.ts'
export {
  createMetadataRefreshWorker,
  DEFAULT_REFRESH_CONFIG,
  type MetadataRefreshConfig,
  type MetadataRefreshConfigGetter,
  type MetadataRefreshDeps,
  type MetadataRefreshWorker,
  type RefreshErrorState,
  type RefreshResult,
} from './application/refresh.ts'
export { registerMetadata } from './infrastructure/http/metadata.ts'
