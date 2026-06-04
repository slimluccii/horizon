// Process entrypoint — thin. Delegates all wiring to the composition root.
import { bootstrap } from './composition/bootstrap.ts'

bootstrap().catch((err) => { console.error(err); process.exit(1) })
