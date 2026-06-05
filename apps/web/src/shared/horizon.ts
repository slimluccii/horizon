import { HorizonClient } from '@horizon/sdk'
export const horizon = new HorizonClient({ baseUrl: '' }) // empty = same origin via Vite proxy
