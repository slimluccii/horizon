# Plan for issue #13: Settings page shell + Personal tab (v1 preference fields)

## Goal
Add a `/settings` route (reached via avatar dropdown) with a tab framework whose
only v1 tab — **Personal** — exposes the five `PreferencesSchema` fields, persists
them via `PATCH /users/:id` with zod validation + server-side merge, and applies
the chosen theme to the web shell immediately on save (and on bootstrap).

## Scope
- Expected files changed: **11**
- Expected lines changed: **~520**
- Within soft caps: **no** (8 files / 400 lines)
- Justification: this slice legitimately spans three workspaces. Server adds
  validation, SDK introduces the shared schema **and** retypes `User.preferences`
  (the issue requires "SDK types derive from it"), and Web adds a new top-level
  page + tab framework + theming hook + nav entry. Well under hard caps (20 /
  1500). Splitting (schema/server vs. UI) would force a no-op intermediate PR.

## Files to change

**SDK (shared schema + types)**
- `libs/sdk/src/preferences.ts` *(new, ~45 lines)* — define and export
  `PreferencesSchema` (zod, `.strict()`) with the five v1 fields, each
  `.optional()` (no `.default()` — defaults are applied at the UI layer so the
  server merge stays a pure dictionary merge, no surprise re-writes of fields
  the caller didn't supply). Export `Preferences = z.infer<typeof
  PreferencesSchema>` (every property optional, matching `.optional()`). Export
  `SUPPORTED_LANGUAGES` — a curated `readonly` tuple of ~20 ISO 639-1 codes
  paired with English labels; the language fields use
  `z.enum(SUPPORTED_LANGUAGES.map(l => l.code) as [string, ...string[]])` so
  server validation and the web picker share the same allowed set.
- `libs/sdk/src/types.ts` *(mod, ~+2/-1 lines)* — `import type { Preferences }
  from './preferences.ts'` and change `User.preferences: Record<string,
  unknown>` (line 169) to `preferences: Preferences`. Because every field on
  `Preferences` is optional, code that today reads `user.preferences.theme`
  still type-checks (it was `unknown` before, now `'dark' | 'light' |
  undefined` — strictly better).
- `libs/sdk/src/client.ts` *(mod, ~+2/-1 lines)* — `import type { Preferences }
  from './preferences.ts'` and retype `users.update` body's `preferences?:
  Record<string, unknown>` (line 65) to `preferences?: Partial<Preferences>`
  (`Partial` is technically redundant since fields are already optional, but
  documents intent: a patch is a sparse subset).
- `libs/sdk/src/index.ts` *(mod, +3 lines)* — re-export `PreferencesSchema`,
  `SUPPORTED_LANGUAGES` (value re-exports), and `Preferences` (type re-export)
  from `./preferences.ts`.
- `libs/sdk/package.json` *(mod, +1 line in `exports`)* — add
  `"./preferences": "./src/preferences.ts"` subpath so the server can import
  the schema without dragging in `client.ts` / `session.ts` / `hls.js`.

**Server**
- `apps/server/package.json` *(mod, +1 line)* — add `"@horizon/sdk": "*"` under
  `dependencies` (workspace dep; resolves via root `package.json` workspaces).
- `apps/server/src/routes/users.ts` *(mod, ~+30/-5 lines)*:
  - Import `PreferencesSchema` from `@horizon/sdk/preferences`.
  - Replace `PatchBody.preferences` (currently `z.record(z.string(),
    z.unknown())`, line 14) with `PreferencesSchema.optional()` — the schema
    is already `.strict()` so unknown keys 400 as `invalid-input`.
  - In the PATCH handler (lines 39–52), if `parse.data.preferences` is set,
    fetch existing user, compute `merged = { ...existing.preferences,
    ...parse.data.preferences }`, then call `users.update(id, { ...rest,
    preferences: merged })`. Keep the existing `404` / `409` paths.
  - `POST /users` body keeps its loose `z.record` — verified that
    `Setup.tsx:23` and `ProfilePicker.tsx:39` both call `users.create` with
    only `{ name, avatar }` (no `preferences`), so creation is effectively
    `preferences: {}` server-side already; tightening it would be a no-op
    surface change. Deferred for that reason.

**Web**
- `apps/web/src/App.tsx` *(mod, +2 lines)* — add `<Route path="/settings"
  element={<Guard><Settings /></Guard>} />` and import.
- `apps/web/src/pages/Settings.tsx` *(new, ~210 lines)* — page component:
  `<LargeTopNav />` chrome + a tab bar (only "Personal" pill rendered, but
  the bar/active-state plumbing is structured so future tabs slot in) +
  the Personal form. Form controls per the AC:
  - `theme`: native `<select>` (`dark` / `light`)
  - `audioLanguage` / `subtitleLanguage`: `<select>` populated from
    `SUPPORTED_LANGUAGES`
  - `subtitlesEnabled`: a styled toggle (label + checkbox; reuse `.eyebrow`-
    style label)
  - `preferredQuality`: `<select>` (`auto` / `1080p` / `720p` / `480p`)
  Hydrates from the active user (`horizon.users.get(userId)`), stores the
  initial server value in a ref/state so we can compute a diff. Local-state
  edits update a `form` object. The Save button is **disabled when the diff
  is empty** (i.e. `JSON.stringify(form) === JSON.stringify(initial)` or
  field-by-field equality — see Steps for the exact rule). On click, build
  `diff = { only fields where form[k] !== initial[k] }` and call
  `horizon.users.update(userId, { preferences: diff })`. On success, mutate
  `document.documentElement.dataset.theme` only if `diff.theme` was set,
  then refresh `initial` to the response so the form is no longer dirty.
- `apps/web/src/pages/Settings.css` *(new, ~100 lines)* — tab bar + form layout.
  Uses existing tokens (`--surface`, `--border`, `--accent`, etc.) for visual
  parity with `Setup.css` / `ProfilePicker.css`.
- `apps/web/src/components/chrome/ProfileBadgeButton.tsx` *(mod, ~+4 lines)* —
  insert a "Settings" `.pb-badge__item` button between "Switch profile" and
  "Delete profile" that calls `navigate('/settings')` and closes the menu.
- `apps/web/src/hooks/useActiveUser.ts` *(mod, ~+10 lines)* — apply theme on
  user load **and clear it on logout**:
  - In the user-load `.then(u => setUser(u))` block (line 47), read
    `u.preferences.theme` (now `'dark' | 'light' | undefined` thanks to the
    SDK retyping) and call `document.documentElement.setAttribute('data-theme',
    theme === 'light' ? 'light' : 'dark')`. Always set the attribute (not
    conditional) so a saved `'dark'` reasserts after a previous `'light'`.
  - In the `if (!userId)` branch (line 44) — i.e. **logout / pre-resolve** —
    remove the attribute via `document.documentElement.removeAttribute(
    'data-theme')` so the next-rendered chrome (e.g. `/profiles`) falls back
    to the default dark palette instead of inheriting the previous user's
    theme. This addresses the prior plan-review finding that logout would
    leave a stale `data-theme="light"` on `<html>`.
- `apps/web/src/styles/tokens.css` *(mod, ~+25 lines)* — add a
  `:root[data-theme="light"] { ... }` block overriding the palette tokens
  (`--bg`, `--bg-deep`, `--surface`, `--surface-2`, `--border`, `--text`,
  `--text-soft`, `--muted`) for a sensible light variant. No attribute
  (default) and `[data-theme="dark"]` both render the current dark palette,
  preserving today's behaviour.

**Tests**
- `apps/server/test/routes.users.test.ts` *(mod, ~+90 lines)* — extend the
  existing `PATCH + DELETE /users/:id` describe with new cases (see below,
  including a positive sweep over `SUPPORTED_LANGUAGES`).

## Out of scope
- `PlaybackOrchestrator` consumption of `audioLanguage` / `subtitleLanguage` /
  `preferredQuality` — issue explicitly defers this to a future slice.
- No SQL migration. `preferences` column stays `TEXT NOT NULL DEFAULT '{}'`.
- No tightening of `POST /users` body — verified call-sites never set
  `preferences` (see Server note above).
- Movies/Series/Collections tab content beyond what `LargeTopNav` already does
  (Settings is not one of the top tabs; it's reached only from the avatar
  dropdown, per the AC).
- A real i18n stack — `SUPPORTED_LANGUAGES` is just a curated label list for
  the picker.
- Other tabs (Playback, Devices, Library, etc.) — only the Personal pill is
  rendered, but the bar accepts a `tabs` array so additions are trivial.
- Android-TV / macOS clients — they read `User.preferences` and will see the
  retyped fields; no behavioural change required, but if any Kotlin/Swift
  binding broke we'd flag and address there. (Smoke check: TV uses its own
  Kotlin DTOs; macOS uses a thin Swift client. Neither imports the TS type.)

## Steps
1. **Add the shared schema first.**
   - Create `libs/sdk/src/preferences.ts`. `PreferencesSchema` is `.strict()`;
     each field is `.optional()` (no `.default()` — see Files note). Build the
     language enum from `SUPPORTED_LANGUAGES.map(l => l.code)`.
   - Update `libs/sdk/src/types.ts` to import `Preferences` and replace
     `User.preferences`'s type.
   - Update `libs/sdk/src/client.ts` to retype the `users.update` body's
     `preferences?` to `Partial<Preferences>`.
   - Re-export schema/type/constant from `libs/sdk/src/index.ts`.
   - Add `"./preferences": "./src/preferences.ts"` to the SDK's `exports` map.
2. **Wire server-side validation + merge.**
   - Add `"@horizon/sdk": "*"` to `apps/server/package.json`.
   - In `apps/server/src/routes/users.ts`, change `PatchBody.preferences` to
     `PreferencesSchema.optional()`.
   - In the PATCH handler, when `preferences` is supplied: fetch existing user,
     compute merged blob, pass merged into `users.update`. Leave the rest of
     the route untouched.
3. **Write the server tests** (test-first preferred for steps 2–3 — see Tests).
   Run `npm -w @horizon/server run test` and confirm only the new tests fail,
   then make them pass.
4. **Add the Web `/settings` route + page.**
   - `Settings.tsx` + `Settings.css`. On mount, hydrate from
     `horizon.users.get(userId)` and store the response's `preferences` blob
     as `initial` (state). Mirror it into a `form` state object.
   - Use the SDK-exported `SUPPORTED_LANGUAGES` for the two language pickers.
   - **Diff computation.** Define
     `diff = Object.fromEntries(Object.entries(form).filter(([k, v]) => v !==
     initial[k]))`. The Save button's `disabled` prop is `Object.keys(diff)
     .length === 0 || busy` — empty-diff → no save fires. (This means we
     never send `{ preferences: {} }`; the round-trip you'd get for that is
     correct but pointless, so we suppress it at the UI.)
   - On submit: `await horizon.users.update(userId, { preferences: diff })`.
     If `diff.theme` was present, set `document.documentElement.dataset.theme
     = diff.theme === 'light' ? 'light' : 'dark'`. Replace `initial` with the
     response's `preferences` so the form becomes pristine again.
   - Add the `/settings` `<Route>` in `App.tsx`.
5. **Hook the avatar dropdown.** Add a `Settings` item to
   `ProfileBadgeButton.tsx` between "Switch profile" and the danger
   "Delete profile" item.
6. **Apply / clear theme on user transitions.** In `useActiveUser.ts`:
   - On user load, `document.documentElement.setAttribute('data-theme',
     user.preferences.theme === 'light' ? 'light' : 'dark')`.
   - On `!userId` (logout, profile switch in progress), call
     `removeAttribute('data-theme')` so subsequent screens render in the
     default palette instead of the prior user's.
7. **Add the light-theme token overrides** to `styles/tokens.css` under
   `:root[data-theme="light"]`. Override `--bg`, `--bg-deep`, `--surface`,
   `--surface-2`, `--border`, `--text`, `--text-soft`, `--muted`. Keep
   `--accent` family intact for brand continuity.
8. **Manual smoke**: `npm run dev`, log in as a profile, open avatar dropdown
   → Settings, flip theme, hit Save, observe shell repaints; reload, verify
   the theme persists and the other fields round-trip. Re-open settings,
   change subtitle language, save, reload — picker reflects saved value.
   **Logout test:** with a `light`-theme user active, click "Switch profile";
   `/profiles` should render in the default dark palette (not light).

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

5. **Every curated language is accepted.** *(Addresses prior review
   feedback — guards against a typo in the curated list silently breaking
   the picker.)*
   - `import { SUPPORTED_LANGUAGES } from '@horizon/sdk/preferences'`.
   - `for (const { code } of SUPPORTED_LANGUAGES)` create a fresh user and
     `PATCH /users/:id` with `{ preferences: { audioLanguage: code,
     subtitleLanguage: code } }` → expect `200` and that the response
     reflects the supplied codes. Single test, parametrized loop — keeps
     test count tight.

6. **Wrong type (string instead of boolean) → 400.**
   - `PATCH /users/:id` with `{ preferences: { subtitlesEnabled: 'yes' } }`
     → `400`.

7. **Empty preferences patch leaves existing prefs untouched.**
   - Seed prefs `{ theme: 'light' }`, `PATCH` body `{ name: 'B' }` (no
     `preferences` key) → `200`, response prefs still `{ theme: 'light' }`.

8. **Partial patch only overwrites the supplied keys.**
   - Seed prefs `{ theme: 'light', subtitlesEnabled: true, audioLanguage:
     'fr' }`. `PATCH` with `{ preferences: { theme: 'dark' } }` → response
     prefs `{ theme: 'dark', subtitlesEnabled: true, audioLanguage: 'fr' }`.

Schema-only unit tests inside `libs/sdk` (`libs/sdk/test/preferences.test.ts`)
are **skipped** to keep scope tight — tests (1)–(6) above exercise the schema
through the route, which is the only consumer.

**Theme application** — covered by manual smoke (step 8), including the
logout-clears-attribute case. No dedicated unit test: `useActiveUser`'s effect
is a one-line `setAttribute` / `removeAttribute` against
`document.documentElement`, and JSDOM-based unit tests would require new
harness setup disproportionate to the value.

## Verification commands
- `npm -w @horizon/sdk run test` — should still pass (no regression; schema is
  additive).
- `npm -w @horizon/server run test` — new PATCH cases pass; existing user/
  progress/etc. tests untouched.
- `npm -w @horizon/server run typecheck` — proves the `@horizon/sdk` subpath
  import resolves.
- `npm -w @horizon/web run build` — TS + Vite build of the web shell;
  confirms the retyped `User.preferences` doesn't break any existing
  consumer (`useActiveUser`, `ProfileBadgeButton`, `ProfilePicker`, etc. all
  only read `.name` / `.avatar` / `.id` today, so no breakage expected).
- `npm run dev` then manual smoke per step 8 (theme flip + reload round-trip +
  logout-clears-theme check).
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
- **`User.preferences` retyping.** Every field on `Preferences` is optional,
  so the type is a strict refinement of `Record<string, unknown>` from the
  reader's perspective (named fields with known types instead of `unknown`).
  Code that today reads `user.preferences.theme` switches from `unknown` to
  `'dark' | 'light' | undefined` — strictly easier to consume, no casts
  required. The only consumer change is the new theme application in
  `useActiveUser.ts`.
- **ISO 639-1 list size.** A 20-language curated set is enough for v1 and keeps
  validation deterministic; if product wants the full ISO list, that's a
  one-line constant swap later.
- **Light theme palette quality.** The light-theme tokens will be a first pass.
  Visual polish (shadows, accent variants) is acceptable as follow-up; AC only
  requires the theme to apply, not to be design-finished.
- **No existing tab framework in the codebase.** The Library page hand-rolls a
  pill bar inside `LargeTopNav`. The Settings tab bar is a new, settings-local
  primitive — *not* extracted into a shared component yet (premature). If a
  second consumer appears, extract then.
