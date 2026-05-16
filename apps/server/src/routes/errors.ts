import type { FastifyReply } from 'fastify'

/** Standard error response shape — { error, code } — used everywhere. */
export interface ErrorResponse {
  error: string
  code: string
}

export function errorReply(
  reply: FastifyReply,
  status: number,
  code: string,
  error: string,
): FastifyReply {
  return reply.status(status).send({ error, code })
}

export const sendNotFound = (reply: FastifyReply, code: string, error: string) =>
  errorReply(reply, 404, code, error)

export const badRequest = (reply: FastifyReply, code: string, error: string) =>
  errorReply(reply, 400, code, error)

export const serverError = (reply: FastifyReply, code: string, error: string) =>
  errorReply(reply, 500, code, error)

export const overCapacity = (reply: FastifyReply, code: string, error: string) =>
  errorReply(reply, 503, code, error)
