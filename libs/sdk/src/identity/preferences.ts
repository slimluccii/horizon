import { z } from 'zod'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'cs', label: 'Czech' },
] as const

const languageCodes = SUPPORTED_LANGUAGES.map(l => l.code) as [string, ...string[]]

export const PreferencesSchema = z.object({
  theme: z.enum(['dark', 'light']).optional(),
  audioLanguage: z.enum(languageCodes).optional(),
  subtitleLanguage: z.enum(languageCodes).optional(),
  subtitlesEnabled: z.boolean().optional(),
  preferredQuality: z.enum(['auto', '1080p', '720p', '480p']).optional(),
  collapseMovieCollections: z.boolean().optional(),
}).strict()

export type Preferences = z.infer<typeof PreferencesSchema>

/** ISO 639-1 (preference codes) → ISO 639-2 variants (what ffprobe reports on
 *  media tracks; both bibliographic and terminological codes where they differ). */
const LANG_1_TO_2: Record<string, string[]> = {
  en: ['eng'], fr: ['fre', 'fra'], de: ['ger', 'deu'], es: ['spa'], it: ['ita'],
  pt: ['por'], nl: ['dut', 'nld'], pl: ['pol'], ru: ['rus'], ja: ['jpn'],
  zh: ['chi', 'zho'], ko: ['kor'], ar: ['ara'], hi: ['hin'], tr: ['tur'],
  sv: ['swe'], no: ['nor', 'nob', 'nno'], da: ['dan'], fi: ['fin'], cs: ['cze', 'ces'],
}

/** Does a media track's language tag match a preference language code?
 *  Track tags are usually ISO 639-2 ('eng', 'nld'), preferences ISO 639-1
 *  ('en', 'nl'); accept either form on the track. */
export function trackMatchesLanguage(trackLanguage: string | undefined, prefCode: string): boolean {
  if (!trackLanguage) return false
  const tag = trackLanguage.toLowerCase()
  if (tag === prefCode) return true
  return (LANG_1_TO_2[prefCode] ?? []).includes(tag)
}

/** Bitrate ceiling (kbps) implied by a preferredQuality setting; 0 = no cap. */
export function preferredQualityMaxBitrate(quality: Preferences['preferredQuality']): number {
  switch (quality) {
    case '1080p': return 8000
    case '720p': return 4000
    case '480p': return 2000
    default: return 0
  }
}
