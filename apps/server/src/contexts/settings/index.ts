// Settings context — public surface.
// Server-settings singleton (typed row + change-event bus) and its HTTP adapter.
export {
  createServerSettings,
  type ServerSettings,
  type ServerSettingsRow,
  type ServerSettingsPatch,
  type SettingsChangeEvent,
} from './infrastructure/persistence/serverSettings.ts'
export { registerSettings } from './infrastructure/http/settings.ts'
