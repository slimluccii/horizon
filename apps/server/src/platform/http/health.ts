import type { FastifyInstance } from 'fastify'
import type { HwAccel } from '../../contexts/playback/index.ts'

export function registerHealth(app: FastifyInstance, hwAccel: HwAccel) {
  app.get('/health', async () => ({
    status: 'ok',
    ffmpeg: hwAccel.ffmpegVersion,
    hwAccel: hwAccel.encoder,
  }))
}
