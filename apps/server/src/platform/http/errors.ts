import type { FastifyReply } from 'fastify'
import { ErrorCodes } from '@horizon/sdk'
import type { ServerErrorCode } from '@horizon/sdk'

/**
 * Re-export the SDK's single source of truth for error codes so server code can
 * write `ErrorCodes.NAME_TAKEN` instead of a bare `'name-taken'` literal. The
 * SDK owns the definition (it has no server dependency), and the server already
 * depends on the SDK — so there is no risk of a circular import.
 */
export { ErrorCodes }
export type { ServerErrorCode }

/** Standard error response shape — { error, code } — used everywhere. */
export interface ErrorResponse {
  error: string
  code: ServerErrorCode
}

export function errorReply(
  reply: FastifyReply,
  status: number,
  code: ServerErrorCode,
  error: string,
): FastifyReply {
  return reply.status(status).send({ error, code })
}

export const sendNotFound = (reply: FastifyReply, code: ServerErrorCode, error: string) =>
  errorReply(reply, 404, code, error)

export const badRequest = (reply: FastifyReply, code: ServerErrorCode, error: string) =>
  errorReply(reply, 400, code, error)

export const serverError = (reply: FastifyReply, code: ServerErrorCode, error: string) =>
  errorReply(reply, 500, code, error)

export const overCapacity = (reply: FastifyReply, code: ServerErrorCode, error: string) =>
  errorReply(reply, 503, code, error)
