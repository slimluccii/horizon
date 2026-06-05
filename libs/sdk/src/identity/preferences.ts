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
