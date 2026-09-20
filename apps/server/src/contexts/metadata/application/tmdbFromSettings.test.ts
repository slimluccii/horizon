import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { keepTmdbInSyncWithSettings } from './tmdbFromSettings.ts'

function fakeSettings(tmdbToken: string | null) {
  const emitter = new EventEmitter()
  let current = { tmdbToken }
  return {
    get: () => current,
    on: (event: 'change', listener: (ev: { patch: { tmdbToken?: string | null } }) => void) => { emitter.on(event, listener) },
    update(patch: { tmdbToken?: string | null; scanCronHour?: number }) {
      current = { ...current, ...patch }
      emitter.emit('change', { patch })
    },
  }
}

describe('keepTmdbInSyncWithSettings', () => {
  it('starts the worker with the token stored in settings', () => {
    const worker = { setTmdb: vi.fn() }
    keepTmdbInSyncWithSettings(fakeSettings('stored-token'), worker, '/tmp/cache')
    expect(worker.setTmdb).toHaveBeenCalledTimes(1)
    expect(worker.setTmdb.mock.calls[0][0]).not.toBeNull()
  })

  it('starts the worker without a client when no token is stored', () => {
    const worker = { setTmdb: vi.fn() }
    keepTmdbInSyncWithSettings(fakeSettings(null), worker, '/tmp/cache')
    expect(worker.setTmdb).toHaveBeenCalledWith(null)
  })

  it('swaps the client when the token changes and clears it when the token is removed', () => {
    const worker = { setTmdb: vi.fn() }
    const settings = fakeSettings(null)
    keepTmdbInSyncWithSettings(settings, worker, '/tmp/cache')

    settings.update({ tmdbToken: 'new-token' })
    expect(worker.setTmdb.mock.calls.at(-1)![0]).not.toBeNull()

    settings.update({ tmdbToken: null })
    expect(worker.setTmdb.mock.calls.at(-1)![0]).toBeNull()
  })

  it('ignores changes to other settings', () => {
    const worker = { setTmdb: vi.fn() }
    const settings = fakeSettings('stored-token')
    keepTmdbInSyncWithSettings(settings, worker, '/tmp/cache')
    settings.update({ scanCronHour: 4 })
    expect(worker.setTmdb).toHaveBeenCalledTimes(1)
  })
})
