import { loadConfig } from './config.ts'
import { detectHwAccel } from './transcode/hwaccel.ts'
import { createScanner } from './scanner/scanner.ts'
import { createSessionManager } from './session/manager.ts'
import { buildServer } from './server.ts'

async function main() {
  const cfg = loadConfig()
  const hwAccel = await detectHwAccel(cfg.forceEncoder)
  const index = await createScanner(cfg)
  const sessions = createSessionManager(cfg)
  const app = await buildServer(cfg, hwAccel, index, sessions)

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`Horizon listening on :${cfg.port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
