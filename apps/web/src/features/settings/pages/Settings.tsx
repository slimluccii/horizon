import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../../identity/hooks/useActiveUser.ts'
import NowPlayingPanel from '../components/NowPlayingPanel.tsx'
import ProfilesPanel from '../components/ProfilesPanel.tsx'
import SecurityPanel from '../components/SecurityPanel.tsx'
import LibraryFoldersPanel from '../components/LibraryFoldersPanel.tsx'
import ScanStatusBadge from '../components/ScanStatusBadge.tsx'
import ServerPanel from '../components/ServerPanel.tsx'
import HouseholdPanel from '../components/HouseholdPanel'
import AllHouseholdsPanel from '../components/AllHouseholdsPanel'
import { SUPPORTED_LANGUAGES } from '@horizon/sdk'
import type { Preferences } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import DevicePanel from '../../identity/components/DevicePanel.tsx'
type Tab = 'Personal' | 'Household' | 'Server' | 'Profiles'

// ---- Personal tab helpers --------------------------------------------

const QUALITY_OPTIONS = ['auto', '1080p', '720p', '480p'] as const

const DEFAULT_FORM: Required<Preferences> = {
  theme: 'dark',
  audioLanguage: 'en',
  subtitleLanguage: 'en',
  subtitlesEnabled: false,
  preferredQuality: 'auto',
  collapseMovieCollections: true,
}

function mergeWithDefaults(prefs: Preferences): Required<Preferences> {
  return {
    theme: prefs.theme ?? DEFAULT_FORM.theme,
    audioLanguage: prefs.audioLanguage ?? DEFAULT_FORM.audioLanguage,
    subtitleLanguage: prefs.subtitleLanguage ?? DEFAULT_FORM.subtitleLanguage,
    subtitlesEnabled: prefs.subtitlesEnabled ?? DEFAULT_FORM.subtitlesEnabled,
    preferredQuality: prefs.preferredQuality ?? DEFAULT_FORM.preferredQuality,
    collapseMovieCollections: prefs.collapseMovieCollections ?? DEFAULT_FORM.collapseMovieCollections,
  }
}

export default function Settings() {
  const navigate = useNavigate()
  const { user, userId, logout, logoutAll } = useActiveUser()

  const [activeTab, setActiveTab] = useState<Tab>('Personal')
  const [initial, setInitial] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [form, setForm] = useState<Required<Preferences>>(DEFAULT_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!userId) return
    horizon.users.get(userId).then(u => {
      const merged = mergeWithDefaults(u.preferences)
      setInitial(merged)
      setForm(merged)
    })
  }, [userId])

  const viewerCanManage = user?.role === 'owner' || user?.role === 'admin'
  // Household management is available to EVERY authenticated user: a household
  // owner (who may be a server-role 'member', e.g. a new_household redeemer)
  // must be able to invite/manage their household. The panel itself gates the
  // owner-only controls; non-owners get a read-only view of their household.
  const tabs: Tab[] = viewerCanManage
    ? ['Personal', 'Household', 'Server', 'Profiles']
    : ['Personal', 'Household']

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

  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  function handleRoleChanged() {
    setActiveTab('Personal')
    showToast('Your role changed.')
  }

  return (
    <div>
      <LargeTopNav />
      {toast && (
        <div role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <main>
        <nav aria-label="Settings sections">
          {tabs.map(tab => (
            <button
              key={tab}
              aria-current={activeTab === tab ? 'page' : undefined}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>

        {activeTab === 'Server' && (
          <>
            <NowPlayingPanel />
            <ScanStatusBadge onToast={showToast} />
            <LibraryFoldersPanel onSave={showToast} />
            <ServerPanel onSave={showToast} />
            <AllHouseholdsPanel />
          </>
        )}

        {activeTab === 'Household' && user && (
          <HouseholdPanel viewerId={user.id} viewerRole={user.role} />
        )}

        {activeTab === 'Profiles' && user && (
          <ProfilesPanel
            viewerId={user.id}
            viewerRole={user.role}
            onRoleChanged={handleRoleChanged}
            onToast={showToast}
          />
        )}

        {activeTab === 'Personal' && (
          <>
            <p>Appearance</p>

            <div>
              <label htmlFor="settings-theme">Theme</label>
              <select
                id="settings-theme"
                value={form.theme}
                onChange={e => set('theme', e.target.value as 'dark' | 'light')}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

            <p>Audio &amp; Subtitles</p>

            <div>
              <label htmlFor="settings-audio-lang">Audio Language</label>
              <select
                id="settings-audio-lang"
                value={form.audioLanguage}
                onChange={e => set('audioLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="settings-sub-lang">Subtitle Language</label>
              <select
                id="settings-sub-lang"
                value={form.subtitleLanguage}
                onChange={e => set('subtitleLanguage', e.target.value)}
              >
                {SUPPORTED_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div>
                <label htmlFor="settings-subtitles">
                  Subtitles Enabled
                </label>
                <input
                  id="settings-subtitles"
                  type="checkbox"
                  checked={form.subtitlesEnabled}
                  onChange={e => set('subtitlesEnabled', e.target.checked)}
                />
              </div>
            </div>

            <p>Playback</p>

            <div>
              <label htmlFor="settings-quality">Preferred Quality</label>
              <select
                id="settings-quality"
                value={form.preferredQuality}
                onChange={e => set('preferredQuality', e.target.value as Required<Preferences>['preferredQuality'])}
              >
                {QUALITY_OPTIONS.map(q => (
                  <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>
                ))}
              </select>
            </div>

            <p>Library</p>

            <div>
              <div>
                <label htmlFor="settings-collapse-collections">
                  Collapse movie collections into one item
                </label>
                <input
                  id="settings-collapse-collections"
                  type="checkbox"
                  checked={form.collapseMovieCollections}
                  onChange={e => set('collapseMovieCollections', e.target.checked)}
                />
              </div>
            </div>

            {error && <p>{error}</p>}

            <div>
              <button
                disabled={!canSave}
                onClick={handleSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>

            <DevicePanel />

            <SecurityPanel
              onToast={showToast}
              onSignOut={() => navigate('/login', { replace: true })}
              logout={logout}
              logoutAll={logoutAll}
            />
          </>
        )}
      </main>
    </div>
  )
}
