import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { ErrorCodes } from '@horizon/sdk'
import { badRequest, errorReply } from '../../../../platform/http/errors.ts'
import { resolveCallerRole, type UserRepo } from '../../../identity/index.ts'
import { arrFolderFromEvent, resolveArrFolder } from '../../domain/arr.ts'
import type { WebhookKeyRepo } from '../persistence/webhookKey.ts'

export interface ArrWebhookDeps {
  keys: WebhookKeyRepo
  users: UserRepo
  getRoots: () => { movies: string[]; shows: string[] }
  hasItemsUnder: (folder: string) => boolean
  requestScan: (req: { trigger: 'webhook'; paths: string[] }) => Promise<unknown>
}

export function registerArrWebhook(app: FastifyInstance, deps: ArrWebhookDeps): void {
  app.post('/webhooks/arr/key', async (req, reply) => {
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')
    if (caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner or admin can generate the webhook key')
    }
    return reply.code(201).send({ key: deps.keys.rotate() })
  })

  // Sonarr and Radarr cannot log in, so this route is on the auth allowlist and checks the key itself.
  app.post('/webhooks/arr', async (req, reply) => {
    const key = req.headers['x-api-key']
    if (typeof key !== 'string' || !deps.keys.matches(key)) {
      return errorReply(reply, 401, ErrorCodes.UNAUTHORIZED, 'Invalid webhook key')
    }
    const event = arrFolderFromEvent(req.body)
    if (!event) return { ignored: true }

    const roots = deps.getRoots()[event.kind]
    // A deleted folder is gone from disk but still has items in the library.
    const paths = resolveArrFolder(event.folder, roots, p => existsSync(p) || deps.hasItemsUnder(p))
    if (paths.length === 0) return { paths }

    void deps.requestScan({ trigger: 'webhook', paths }).catch(err => req.log.error({ err }, 'Webhook scan failed'))
    return reply.code(202).send({ paths })
  })
}
