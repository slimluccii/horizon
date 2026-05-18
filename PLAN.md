# Plan for issue #13: Settings page shell + Personal tab (v1 preference fields)

## Goal
Add a `/settings` route (reached via avatar dropdown) with a tab framework whose
only v1 tab — **Personal** — exposes the five `PreferencesSchema` fields, persists
them via `PATCH /users/:id` with zod validation + server-side merge, and applies
the chosen theme to the web shell immediately on save (and on bootstrap).

## Scope
- Expected files changed: **11**
- Expected lines changed: **~500**
- Within soft caps: **no** (8 files / 400 lines)
- Justification: this slice legitimately spans three workspaces. Server adds
  validation, SDK introduces the shared schema (the issue requires "SDK types
  derive from it"), and Web adds a new top-level page + tab framework + theming
  hook + nav entry. Well under hard caps (20 / 1500). Splitting (schema/server
  vs. UI) would force a no-op intermediate PR.

## Files to change

**SDK (shared schema)**
- `libs/sdk/src/preferences.ts` *(new, ~40 lines)* — define and export
  `PreferencesSchema` (zod) with the five v1 fields + defaults; export
  `Preferences = z.infer<typeof PreferencesSchema>`. `.strict()` so unknown keys
  reject. Includes a small `SUPPORTED_LANGUAGES` constant (curated ISO 639-1
  list) so server validation and the web picker share the same allowed set.
- `libs/sdk/src/index.ts` *(mod, +2 lines)* — re-export `PreferencesSchema`,
  `Preferences`, `SUPPORTED_LANGUAGES` from `./preferences.ts`.
- `libs/sdk/package.json` *(mod, +1 line in `exports`)* — add
  `"./preferences": "./src/preferences.ts"` subpath so the server can import
  the schema without dragging in `client.ts` / `session.ts` / `hls.js`.

**Server**
- `apps/server/package.json` *(mod, +1 line)* — add `"@horizon/sdk": "*"` under
  `dependencies` (workspace dep; resolves via root `package.json` workspaces).
- `apps/server/src/routes/users.ts` *(mod, ~+30/-5 lines)*:
  - Import `PreferencesSchema` from `@horizon/sdk/preferences`.
  - Replace `PatchBody.preferences` (currently `z.record(z.string(), z.unknown())`)
    with `PreferencesSchema.partial().strict().optional()` so unknown keys 400 as
    `invalid-input`.
  - In the PATCH handler (lines 39–52), if `parse.data.preferences` is set,
    fetch existing user, compute `merged = { ...existing.preferences,
    ...parse.data.preferences }`, then call `users.update(id, { ...rest,
    preferences: merged })`. Keep the existing `404` / `409` paths.
  - `POST /users` body keeps its loose `z.record` (creation isn't in the AC and
    the seed/profile-picker flows pass `{}`). Validation tightening for create
    can be a follow-up.

**Web**
- `apps/web/src/App.tsx` *(mod, +2 lines)* — add `<Route path="/settings"
  element={<Guard><Settings /></Guard>} />` and import.
- `apps/web/src/pages/Settings.tsx` *(new, ~200 lines)* — page component:
  `<LargeTopNav />` chrome + a tab bar (only "Personal" pill rendered, but
  the bar/active-state plumbing is structured so future tabs slot in) +
  the Personal form. Form controls per the AC:
  - `theme`: native `<select>` (`dark` / `light`)
  - `audioLanguage` / `subtitleLanguage`: `<select>` populated from
    `SUPPORTED_LANGUAGES`
  - `subtitlesEnabled`: a styled toggle (label + checkbox; reuse `.eyebrow`-
    style label)
  - `preferredQuality`: `<select>` (`auto` / `1080p` / `720p` / `480p`)
  Hydrates from the active user (`horizon.users.get(userId)`), local-state
  edits, **Save** button calls `horizon.users.update(userId, { preferences:
  diff })` (only changed fields, so unknown-key behaviour is also exercised in
  practice). On success, mutate `document.documentElement.dataset.theme` to
  reflect the saved theme immediately.
- `apps/web/src/pages/Settings.css` *(new, ~100 lines)* — tab bar + form layout.
  Uses existing tokens (`--surface`, `--border`, `--accent`, etc.) for visual
  parity with `Setup.css` / `ProfilePicker.css`.
- `apps/web/src/components/chrome/ProfileBadgeButton.tsx` *(mod, ~+5 lines)* —
  insert a "Settings" `.pb-badge__item` button between "Switch profile" and
  "Delete profile" that calls `navigate('/settings')` and closes the menu.
- `apps/web/src/hooks/useActiveUser.ts` *(mod, ~+6 lines)* — when the user
  resolves (existing `.then(u => setUser(u))` block, line 47), read
  `u.preferences.theme` (parsed permissively — if invalid, fall back to
  `'dark'`) and call `document.documentElement.setAttribute('data-theme',
  theme)`. Single source of truth for theme application on bootstrap +
  profile switch.
- `apps/web/src/styles/tokens.css` *(mod, ~+25 lines)* — add a
  `:root[data-theme="light"] { ... }` block overriding the palette tokens
  (`--bg`, `--surface`, `--text`, etc.) for a sensible light variant. Default
  (no attribute) stays dark to preserve current behaviour.

**Tests**
- `apps/server/test/routes.users.test.ts` *(mod, ~+80 lines)* — extend the
  existing `PATCH + DELETE /users/:id` describe with new cases (see below).

## Out of scope
- `PlaybackOrchestrator` consumption of `audioLanguage` / `subtitleLanguage` /
  `preferredQuality` — issue explicitly defers this to a future slice.
- No SQL migration. `preferences` column stays `TEXT NOT NULL DEFAULT '{}'`.
- No tightening of `POST /users` body — creation path keeps its loose
  `z.record(z.string(), z.unknown())`.
- Movies/Series/Collections tab content beyond what `LargeTopNav` already does
  (Settings is not one of the top tabs; it's reached only from the avatar
  dropdown, per the AC).
- A real i18n stack — `SUPPORTED_LANGUAGES` is just a curated label list for
  the picker.
- Other tabs (Playback, Devices, Library, etc.) — only the Personal pill is
  rendered, but the bar accepts a `tabs` array so additions are trivial.
- Android-TV / macOS clients — they read `User.preferences` as
  `Record<String, …>` already; honouring the typed fields is future work.

## Steps
1. **Add the shared schema first.**
   - Create `libs/sdk/src/preferences.ts` with `PreferencesSchema` (`.strict()`,
     each field optional with `.default(...)`), `Preferences` type alias, and
     `SUPPORTED_LANGUAGES` constant (e.g. ~20 ISO 639-1 codes + English labels).
   - Re-export from `libs/sdk/src/index.ts`.
   - Add `"./preferences": "./src/preferences.ts"` to the SDK's `exports` map.
2. **Wire server-side validation + merge.**
   - Add `"@horizon/sdk": "*"` to `apps/server/package.json`.
   - In `apps/server/src/routes/users.ts`, change `PatchBody.preferences` to
     `PreferencesSchema.partial().strict().optional()`.
   - In the PATCH handler, when `preferences` is supplied: fetch existing user,
     compute merged blob, pass merged into `users.update`. Leave the rest of
     the route untouched.
3. **Write the server tests** (test-first preferred for steps 2–3 — see Tests).
   Run `npm -w @horizon/server run test` and confirm only the new tests fail,
   then make them pass.
4. **Add the Web `/settings` route + page.**
   - `Settings.tsx` + `Settings.css`. Hydrate from `horizon.users.get(userId)`.
   - Use the SDK-exported `SUPPORTED_LANGUAGES` for the two language pickers.
   - Save handler builds a diff (only fields the user changed), calls
     `horizon.users.update`, then applies `document.documentElement.dataset
     .theme` on success.
   - Add the `/settings` `<Route>` in `App.tsx`.
5. **Hook the avatar dropdown.** Add a `Settings` item to
   `ProfileBadgeButton.tsx` between "Switch profile" and the danger
   "Delete profile" item.
6. **Apply theme on bootstrap / profile switch.** In `useActiveUser.ts`, in
   the user-load effect, set `data-theme` on `<html>` based on
   `user.preferences.theme` (treat anything other than `'light'` as default
   dark; clear the attribute if dark).
7. **Add the light-theme token overrides** to `styles/tokens.css` under
   `:root[data-theme="light"]`. Override `--bg`, `--bg-deep`, `--surface`,
   `--surface-2`, `--border`, `--text`, `--text-soft`, `--muted`. Keep `--accent`
   family intact for brand continuity.
8. **Manual smoke**: `npm run dev`, log in as a profile, open avatar dropdown
   → Settings, flip theme, hit Save, observe shell repaints; reload, verify
   the theme persists and the other fields round-trip. Re-open settings,
   change subtitle language, save, reload — picker reflects saved value.

## Tests
**Test-first: yes.** Write these failing tests before implementing step 2.

`apps/server/test/routes.users.test.ts` (extend existing file):

1. **Schema accepts valid prefs and persists merged blob.**
   - Seed user via `users.create({ name: 'A', preferences: { theme: 'dark',
     audioLanguage: 'en' } })`.
   - `PATCH /users/:id` with body `{ preferences: { theme: 'light' } }` →
     `200`, response `preferences` equals
     `{ theme: 'light', audioLanguage: 'en' }`. Validates merge semantics.

2. **Unknown key in `preferences` → 400 `invalid-input`.**
   - `PATCH /users/:id` with `{ preferences: { theme: 'dark', foo: 'bar' } }`
     → `400`, `code === 'invalid-input'`. Validates `.strict()`.

3. **Invalid enum value → 400 `invalid-input`.**
   - `PATCH /users/:id` with `{ preferences: { theme: 'midnight' } }` → `400`.

4. **Invalid language code → 400 `invalid-input`.**
   - `PATCH /users/:id` with `{ preferences: { audioLanguage: 'klingon' } }`
     → `400` (language enum restricted to `SUPPORTED_LANGUAGES` codes).

5. **Wrong type (boolean instead of string) → 400.**
   - `PATCH /users/:id` with `{ preferences: { subtitlesEnabled: 'yes' } }`
     → `400`.

6. **Empty preferences patch leaves existing prefs untouched.**
   - Seed prefs `{ theme: 'light' }`, `PATCH` body `{ name: 'B' }` (no
     `preferences` key) → `200`, response prefs still `{ theme: 'light' }`.

7. **Partial patch only overwrites the supplied keys.**
   - Seed prefs `{ theme: 'light', subtitlesEnabled: true, audioLanguage:
     'fr' }`. `PATCH` with `{ preferences: { theme: 'dark' } }` → response
     prefs `{ theme: 'dark', subtitlesEnabled: true, audioLanguage: 'fr' }`.

Schema-only unit tests live inside `libs/sdk` if `libs/sdk/test/preferences.test.ts`
is desired; not required for AC coverage since (1)–(5) above exercise the schema
through the route. Skip to keep scope tight.

**Theme application** — covered by manual smoke (step 8). No dedicated unit
test: it's a one-line `setAttribute` against `document.documentElement`, and
JSDOM-based unit tests of `useActiveUser` would require new harness setup
disproportionate to the value.

## Verification commands
- `npm -w @horizon/sdk run test` — should still pass (no regression; schema is
  additive).
- `npm -w @horizon/server run test` — new PATCH cases pass; existing user/
  progress/etc. tests untouched.
- `npm -w @horizon/server run typecheck` — proves the `@horizon/sdk` subpath
  import resolves.
- `npm -w @horizon/web run build` — TS + Vite build of the web shell.
- `npm run dev` then manual smoke per step 8 (theme flip + reload round-trip).
- No Playwright run required for this slice; existing `profiles.spec.ts`
  shouldn't regress because the dropdown gains a new entry but keeps existing
  ones.

## Risks / open questions
- **`@horizon/sdk` subpath export from a Node consumer.** The server uses
  `NodeNext` module resolution and the SDK declares `"type": "module"` with
  `.ts` files in `exports`. The server already runs TS via `ts-node/esm`, so
  `import { PreferencesSchema } from '@horizon/sdk/preferences'` should resolve
  the same way the web app resolves `@horizon/sdk` today. If `ts-node`'s loader
  chokes on the subpath, fall back to a relative import
  (`../../../../libs/sdk/src/preferences.ts`) — ugly but unblocks. The
  subpath route is preferred; flag during step 2 if the typecheck or test run
  fails.
- **ISO 639-1 list size.** A 20-language curated set is enough for v1 and keeps
  validation deterministic; if product wants the full ISO list, that's a
  one-line constant swap later.
- **Light theme palette quality.** The light-theme tokens will be a first pass.
  Visual polish (shadows, accent variants) is acceptable as follow-up; AC only
  requires the theme to apply, not to be design-finished.
- **`POST /users` body still loose.** Profile-creation paths in Setup /
  ProfilePicker pass `preferences: undefined` or `{}`, so tightening creation
  would either change those call-sites or accept loose creation. Out of scope
  for this issue.
- **No existing tab framework in the codebase.** The Library page hand-rolls a
  pill bar inside `LargeTopNav`. The Settings tab bar is a new, settings-local
  primitive — *not* extracted into a shared component yet (premature). If a
  second consumer appears, extract then.
