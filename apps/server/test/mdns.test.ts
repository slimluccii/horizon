import { describe, it, expect, vi } from 'vitest'
import { startMdns } from '../src/mdns.ts'
import type { Identity } from '../src/identity.ts'

const identity: Identity = { instanceId: 'id-9', serverName: 'Den', version: '0.1.0' }

describe('startMdns', () => {
  it('publishes a _horizon._tcp service with identity txt and stops cleanly', () => {
    const unpublishAll = vi.fn((cb: () => void) => cb())
    const destroy = vi.fn()
    const publish = vi.fn(() => ({}))
    const fakeBonjour = { publish, unpublishAll, destroy }

    const handle = startMdns(identity, 7777, () => fakeBonjour as any)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Den',
      type: 'horizon',
      port: 7777,
      txt: { id: 'id-9', name: 'Den', v: '0.1.0' },
    }))

    handle.stop()
    expect(unpublishAll).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
  })
})
