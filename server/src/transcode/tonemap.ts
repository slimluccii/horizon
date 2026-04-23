/**
 * HDR → SDR tone-mapping filter chain. Picks an operator + sensible defaults
 * per operator, plus a brightness/saturation correction stage to compensate
 * for the absence of libzimg.
 *
 * Background — why this is harder than `tonemap=hable`:
 * The `tonemap` filter assumes its input is in *linear* RGB. With libzimg /
 * libplacebo we'd do PQ → linear → tonemap → BT.709 properly. Without those,
 * we feed it gamma-encoded YUV and the operator works in the wrong space,
 * crushing midtones. We compensate downstream with `eq` (gamma + saturation +
 * contrast). When you build ffmpeg with `--enable-libzimg`, swap this for the
 * proper zscale chain.
 */

export type ToneMapOperator =
  | 'hable'      // Filmic, cinematic, preserves highlights — industry standard
  | 'mobius'     // Smoother roll-off, brighter mids
  | 'reinhard'   // Simple, slightly flat
  | 'gamma'      // Power-curve only
  | 'clip'       // Hard clip — high contrast, blown highlights
  | 'linear'     // Multiply — generally blows highlights
  | 'none'       // No tonemap (debug)

export const ALL_TONEMAP_OPERATORS: ToneMapOperator[] = [
  'hable', 'mobius', 'reinhard', 'gamma', 'clip', 'linear', 'none',
]

export interface ToneMapConfig {
  operator: ToneMapOperator
  /** Per-operator curve parameter (only mobius/gamma/reinhard use it). */
  param?: number
  /** Desaturation strength (0 = none). HDR sources oversaturate after a naive
   *  tonemap, so a small touch is usually wanted; we set per-operator defaults. */
  desat?: number
  /** Source signal peak luminance hint (cd/m²). 100 ≈ SDR, 1000 ≈ HDR10 typical. */
  peak?: number
  /** Post-tonemap correction (gamma/saturation/contrast). Disable to debug raw operator. */
  postCorrection?: boolean
}

/**
 * Recommended defaults per operator. These were tuned against real DV/HDR10
 * 2160p content on a calibrated SDR display; tweak via env if your display
 * differs significantly.
 */
const OPERATOR_DEFAULTS: Record<ToneMapOperator, Required<Pick<ToneMapConfig, 'param' | 'desat' | 'peak'>>> = {
  hable:    { param: 0.0, desat: 0.5, peak: 100 },   // hable ignores param
  mobius:   { param: 0.3, desat: 0.0, peak: 100 },   // current default — gentler than hable
  reinhard: { param: 0.5, desat: 1.0, peak: 100 },
  gamma:    { param: 1.5, desat: 0.0, peak: 100 },
  clip:     { param: 0.0, desat: 0.0, peak: 100 },
  linear:   { param: 1.0, desat: 0.0, peak: 100 },
  none:     { param: 0.0, desat: 0.0, peak: 100 },
}

/**
 * Post-tonemap correction tuned per operator. hable looks naturally cinematic
 * (slightly dim → boost gamma a touch). mobius keeps mids → minimal correction.
 * reinhard is flat → boost contrast.
 */
const POST_CORRECTION: Record<ToneMapOperator, string | null> = {
  hable:    'eq=gamma=1.15:saturation=1.15:contrast=1.05',
  mobius:   'eq=gamma=1.25:saturation=1.30:contrast=1.05',
  reinhard: 'eq=gamma=1.10:saturation=1.10:contrast=1.15',
  gamma:    null,
  clip:     null,
  linear:   null,
  none:     null,
}

export function isToneMapOperator(s: string): s is ToneMapOperator {
  return (ALL_TONEMAP_OPERATORS as string[]).includes(s)
}

/**
 * Build the tonemap prefix that goes at the front of `[0:v]` in the filter
 * graph. Output is `yuv420p` (downstream scale + pad expects 8-bit YUV).
 *
 * Returns empty string when operator is `none` and post-correction is off,
 * so the caller can drop the prefix entirely.
 */
export function buildToneMapPrefix(cfg: ToneMapConfig): string {
  const { operator } = cfg
  const defaults = OPERATOR_DEFAULTS[operator]
  const param = cfg.param ?? defaults.param
  const desat = cfg.desat ?? defaults.desat
  const peak = cfg.peak ?? defaults.peak

  // Build tonemap params. param is only meaningful for some ops; pass it
  // anyway when non-zero so users can tune even unsupported ones safely.
  const tonemapArgs = [`tonemap=${operator}`]
  if (param > 0) tonemapArgs.push(`param=${param}`)
  if (desat !== undefined) tonemapArgs.push(`desat=${desat}`)
  if (peak > 0) tonemapArgs.push(`peak=${peak}`)
  const tonemapNode = tonemapArgs.join(':')

  const wantsCorrection = cfg.postCorrection !== false
  const correction = wantsCorrection ? POST_CORRECTION[operator] : null

  // Always force yuv420p so downstream scale chain has a stable pixel format.
  const parts = [tonemapNode, 'format=yuv420p']
  if (correction) parts.push(correction)
  return parts.join(',') + ','
}
