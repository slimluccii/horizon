import { useEffect, useState } from 'react'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { SUPPORTED_LANGUAGES } from '@horizon/sdk'
import type { Preferences } from '@horizon/sdk'
import LargeTopNav from '../components/chrome/LargeTopNav.tsx'
import './Settings.css'

type Tab = 'Personal'

const QUALITY_OPTIONS = ['auto', '1080p', '720p', '480p'] as const

const DEFAULT_FORM: Required<Preferences> = {
  theme: 'dark',
  audioLanguage: 'en',
  subtitleLanguage: 'en',
  subtitlesEnabled: false,
  preferredQuality: 'auto',
}

function mergeWithDefaults(prefs: Preferences): Required<Preferences> {
  return {
    theme: prefs.theme ?? DEFAULT_FORM.theme,
    audioLanguage: prefs.audioLanguage ?? DEFAULT_FORM.audioLanguage,
    subtitleLanguage: prefs.subtitleLanguage ?? DEFAULT_FORM.subtitleLanguage,
    subtitlesEnabled: prefs.subtitlesEnabled ?? DEFAULT_FORM.subtitlesEnabled,
    preferredQuality: prefs.preferredQuality ?? DEFAULT_FORM.preferredQuality,
  }
}

export default function Settings() {
  const { userId } = useActiveUser()

  const [activeTab, setActiveTab] = useState<Tab>('Personal')
  const [initial, setInitial] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [form, setForm] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) return
    horizon.users.get(userId).then(u => {
      const merged = mergeWithDefaults(u.preferences)
      setInitial(merged)
      setForm(merged)
    })
  }, [userId])

  const tabs: Tab[] = ['Personal']

  const diff = Object.fromEntries(
    Object.entries(form).filter(([k, v]) => v !== initial[k as keyof typeof initial])
  ) as Partial<Preferences>

  const canSave = Object.keys(diff).length > 0 && !busy

  async function handleSave() {
    if (!userId || !canSave) return
    setBusy(true)
    setError(null)
    try {
      const updated = await horizon.users.update(userId, { preferences: diff })
      const merged = mergeWithDefaults(updated.preferences)
      setInitial(merged)
      setForm(merged)
      if (diff.theme !== undefined) {
        document.documentElement.dataset.theme = diff.theme === 'light' ? 'light' : 'dark'
      }
    } catch {
      setError('Failed to save settings. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function set<K extends keyof Required<Preferences>>(key: K, value: Required<Preferences>[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  return (
    <div className="settings">
      <LargeTopNav />
      <div className="settings__body">
        <div className="settings__tabs">
          {tabs.map(tab => (
            <button
              key={tab}
              className={`settings__tab ${activeTab === tab ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'Personal' && (
          <>
            <p className="settings__section-title">Appearance</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-theme">Theme</label>
              <select
                id="settings-theme"
                className="settings__select"
                value={form.theme}
                onChange={e => set('theme', e.target.value as 'dark' | 'light')}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

            <p className="settings__section-title">Audio &amp; Subtitles</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-audio-lang">Audio Language</label>
              <select
                id="settings-audio-lang"
                className="settings__select"
                value={form.audioLanguage}
                onChange={e => set('audioLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-sub-lang">Subtitle Language</label>
              <select
                id="settings-sub-lang"
                className="settings__select"
                value={form.subtitleLanguage}
                onChange={e => set('subtitleLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="settings__field">
              <div className="settings__toggle-row">
                <label className="settings__toggle-label" htmlFor="settings-subtitles">
                  Subtitles Enabled
                </label>
                <input
                  id="settings-subtitles"
                  type="checkbox"
                  className="settings__toggle-input"
                  checked={form.subtitlesEnabled}
                  onChange={e => set('subtitlesEnabled', e.target.checked)}
                />
              </div>
            </div>

            <p className="settings__section-title">Playback</p>

            <div className="settings__field">
              <label className="settings__label" htmlFor="settings-quality">Preferred Quality</label>
              <select
                id="settings-quality"
                className="settings__select"
                value={form.preferredQuality}
                onChange={e => set('preferredQuality', e.target.value as Required<Preferences>['preferredQuality'])}
              >
                {QUALITY_OPTIONS.map(q => (
                  <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>
                ))}
              </select>
            </div>

            {error && <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{error}</p>}

            <div className="settings__actions">
              <button
                className="settings__save"
                disabled={!canSave}
                onClick={handleSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
