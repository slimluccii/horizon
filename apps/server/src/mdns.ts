import { Bonjour } from 'bonjour-service'
import type { Identity } from './identity.ts'

export interface MdnsHandle {
  stop(): void
}

/** Factory injected for tests; defaults to a real Bonjour instance. */
type BonjourLike = {
  publish: (opts: unknown) => unknown
  unpublishAll: (cb: () => void) => void
  destroy: () => void
}

/**
 * Advertise this server as `_horizon._tcp.local` with identity in TXT records.
 * Best-effort: multicast may be unavailable (bridged Docker) — callers treat
 * failure as non-fatal.
 */
export function startMdns(
  identity: Identity,
  port: number,
  makeBonjour: () => BonjourLike = () => new Bonjour() as unknown as BonjourLike,
): MdnsHandle {
  const bonjour = makeBonjour()
  bonjour.publish({
    name: identity.serverName,
    type: 'horizon',
    port,
    txt: { id: identity.instanceId, name: identity.serverName, v: identity.version },
  })
  return {
    stop() {
      bonjour.unpublishAll(() => bonjour.destroy())
    },
  }
}
