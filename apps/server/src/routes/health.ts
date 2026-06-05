import type { FastifyInstance } from 'fastify'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Identity } from '../identity.ts'

export function registerHealth(app: FastifyInstance, hwAccel: HwAccel, identity: Identity) {
  app.get('/health', async () => ({
    status: 'ok',
    ffmpeg: hwAccel.ffmpegVersion,
    hwAccel: hwAccel.encoder,
    serverName: identity.serverName,
    instanceId: identity.instanceId,
    version: identity.version,
  }))
}
