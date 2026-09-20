import { createTmdbProvider, type TmdbProvider } from '../infrastructure/tmdb/tmdb.ts'

interface TmdbSettings {
  get(): { tmdbToken: string | null }
  on(event: 'change', listener: (ev: { patch: { tmdbToken?: string | null } }) => void): unknown
}

interface TmdbConsumer {
  setTmdb(tmdb: TmdbProvider | null): void
}

/** The stored token is the only source for the TMDB client, at boot and on every change. */
export function keepTmdbInSyncWithSettings(settings: TmdbSettings, worker: TmdbConsumer, cacheDir: string): void {
  worker.setTmdb(createTmdbProvider(settings.get().tmdbToken ?? undefined, cacheDir))
  settings.on('change', ({ patch }) => {
    if (patch.tmdbToken === undefined) return
    // Never log the token value, only that it changed.
    console.log(`Server settings: TMDB token ${patch.tmdbToken ? 'updated' : 'cleared'}`)
    worker.setTmdb(createTmdbProvider(patch.tmdbToken ?? undefined, cacheDir))
  })
}
