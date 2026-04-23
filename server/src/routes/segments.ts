import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Session } from '../session/types.ts'
import type { SessionManager } from '../session/manager.ts'
import { waitForSegment, waitForInit } from '../transcode/ffmpeg.ts'
import { restartAtSegment } from '../transcode/restart.ts'
import { sendNotFound, badRequest, serverError } from './errors.ts'

/** Lookahead window (segments). Requests for segs >= currentStartSegment and
 *  within this many ahead are considered "current ffmpeg run will produce them";
 *  further-out requests trigger a seek-restart. 30 segs ≈ 2 min at 4 s/seg —
 *  beyond that, restarting is faster than waiting. */
const SEEK_LOOKAHEAD_SEGMENTS = 30

const INIT_WAIT_MS = 30_000
const SEGMENT_WAIT_MS = 60_000

const SEGMENT_NAME_RE = /^seg(\d+)\.m4s$/

/** Log cold-start elapsed once per ffmpeg run — the moment the player gets
 *  the first segment from this run is the user-visible ready moment. */
function logFirstSegment(session: Session, segNum: number): void {
  if (session.spawnedAt && session.firstSegLoggedAt !== session.spawnedAt) {
    const elapsed = Date.now() - session.spawnedAt
    console.log(`Session ${session.id}: first seg${segNum} served +${elapsed}ms from spawn`)
    session.firstSegLoggedAt = session.spawnedAt
  }
}

export function registerSegments(
  app: FastifyInstance,
  hwAccel: HwAccel,
  sessions: SessionManager,
): void {
  app.get<{ Params: { id: string; r: string; seg: string } }>(
    '/sessions/:id/renditions/:r/:seg',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return sendNotFound(reply, 'session-not-found', 'Session not found')
      if (!/^\d+$/.test(req.params.r)) return badRequest(reply, 'invalid-input', 'Invalid rendition')

      const r = parseInt(req.params.r, 10)
      const segReq = path.basename(req.params.seg)
      const segPath = path.join(session.sessionDir, `r${r}`, segReq)

      // Init segments live in the rendition dir but aren't sequenced; serve
      // directly. Briefly wait if not on disk yet — ffmpeg writes init alongside
      // seg0, so a freshly-spawned run may not have flushed it yet.
      if (segReq === 'init.mp4' || segReq.startsWith('init_')) {
        if (!existsSync(segPath)) await waitForInit(session, r, INIT_WAIT_MS)
        if (!existsSync(segPath)) return sendNotFound(reply, 'not-ready', 'Init not ready')
        return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
      }

      const m = SEGMENT_NAME_RE.exec(segReq)
      if (!m) return badRequest(reply, 'invalid-input', 'Invalid segment name')
      const segNum = parseInt(m[1], 10)

      // Fast path: segment already on disk
      if (existsSync(segPath)) {
        logFirstSegment(session, segNum)
        return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
      }

      // Out-of-range request = seek. Trigger ffmpeg restart at the requested
      // seg. In-range requests just wait for the current run to catch up.
      const start = session.currentStartSegment
      const inRange = segNum >= start && segNum < start + SEEK_LOOKAHEAD_SEGMENTS

      if (!inRange && !session.ffmpegRestartInFlight) {
        console.log(`Session ${session.id}: seek detected — req seg${segNum}, current start ${start}`)
        session.ffmpegRestartInFlight = true
        try {
          // Re-check inside lock — another concurrent request may have just
          // restarted into a range that now covers segNum.
          const stillStart = session.currentStartSegment
          const stillInRange = segNum >= stillStart && segNum < stillStart + SEEK_LOOKAHEAD_SEGMENTS
          if (!stillInRange) {
            await restartAtSegment(session, hwAccel, session.profiles, segNum)
          }
        } catch (err) {
          console.error(`Session ${session.id}: seek-restart failed`, err)
          return serverError(reply, 'seek-restart-failed', 'Seek restart failed')
        } finally {
          session.ffmpegRestartInFlight = false
        }
      } else if (!inRange) {
        console.log(`Session ${session.id}: seek waiting on in-flight restart (req seg${segNum}, current start ${start})`)
      }

      const ok = await waitForSegment(session, r, segNum, SEGMENT_WAIT_MS)
      if (!ok || !existsSync(segPath)) return sendNotFound(reply, 'not-ready', 'Segment not produced')
      logFirstSegment(session, segNum)
      return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
    },
  )

  app.get<{ Params: { id: string } }>('/sessions/:id/direct', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return sendNotFound(reply, 'session-not-found', 'Session not found')

    const { size } = statSync(session.filePath)
    const range = req.headers.range
    if (range) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-')
      const start = parseInt(startStr, 10)
      const end = endStr ? parseInt(endStr, 10) : size - 1
      if (isNaN(start) || isNaN(end) || start < 0 || end >= size || start > end) {
        return reply.status(416).header('Content-Range', `bytes */${size}`).send()
      }
      reply.status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', 'video/x-matroska')
      return reply.send(createReadStream(session.filePath, { start, end }))
    }
    reply.header('Content-Type', 'video/x-matroska').header('Content-Length', size)
    return reply.send(createReadStream(session.filePath))
  })

  app.get<{ Params: { id: string; trackIdx: string } }>(
    '/sessions/:id/subtitles/:trackIdx.vtt',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return sendNotFound(reply, 'session-not-found', 'Session not found')
      if (!/^\d+$/.test(req.params.trackIdx)) return badRequest(reply, 'invalid-input', 'Invalid track index')

      const vttPath = path.join(session.sessionDir, `sub_${req.params.trackIdx}.vtt`)
      if (!existsSync(vttPath)) return sendNotFound(reply, 'not-ready', 'Subtitle not ready')
      const content = await readFile(vttPath, 'utf8')
      return reply.header('Content-Type', 'text/vtt').send(content)
    },
  )
}
