import { spawn } from 'node:child_process'

export interface Keyframe {
  ptsSec: number
  /** Decode time. ffmpeg trims a stream copy against this, not against the presentation time. */
  dtsSec: number
}

/** Parse `ffprobe -show_entries packet=pts_time,dts_time,flags -of csv=p=0` output. */
export function parseKeyframes(csv: string): Keyframe[] {
  const keyframes: Keyframe[] = []
  for (const line of csv.split('\n')) {
    const [pts, dts, flags] = line.trim().split(',')
    if (!flags?.startsWith('K')) continue
    const ptsSec = Number.parseFloat(pts)
    if (!Number.isFinite(ptsSec)) continue
    const dtsSec = Number.parseFloat(dts)
    keyframes.push({ ptsSec, dtsSec: Number.isFinite(dtsSec) ? dtsSec : ptsSec })
  }
  return keyframes.sort((a, b) => a.ptsSec - b.ptsSec)
}

/**
 * List the video keyframes of a file. This demuxes the whole file, so it takes
 * minutes for a large remux on spinning disks; callers run it in the background.
 */
export function extractKeyframes(filePath: string, signal?: AbortSignal): Promise<Keyframe[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const out: Buffer[] = []
    let err = ''
    proc.stdout.on('data', chunk => out.push(chunk))
    proc.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-2000) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffprobe exited with code ${code}: ${err.trim()}`))
      else resolve(parseKeyframes(Buffer.concat(out).toString('utf8')))
    })
  })
}
