# Multi-Household Auth (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the web UI for the multi-household auth model — SDK methods, a Settings "Household" panel (members/rename/remove/invites), grant selection in TV pairing approval, and a friend-onboarding redeem page.

**Architecture:** Server endpoints already exist (PRs #118/#120); this is SDK client methods + React UI that consumes them. Feature-based `apps/web/src/features/*`; identity rides the `hz_session` cookie via the `horizon` SDK singleton and `useActiveUser`.

**Tech Stack:** TypeScript, React 18, react-router-dom v6, Vite, `@horizon/sdk`, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-06-multi-household-auth-web-design.md`

**Conventions (verified in-repo):**
- SDK client: `libs/sdk/src/client/client.ts`, `HorizonClient` with `private fetch<T>(path, init)` that prefixes `/api`, sends `credentials: 'include'`, sets JSON `Content-Type` only when a body is present, and throws on `!res.ok`. Namespaces are `readonly` object literals (`library`, `users`, `auth`, …).
- SDK types live in `libs/sdk/src/identity/user.ts` (e.g. `AuthSession`, `User`, `PairPollResult`). Barrel: `libs/sdk/src/index.ts`.
- SDK tests (`libs/sdk/src/client/client.test.ts`): `spyFetch(body, status)` stubs global `fetch`, returns the spy; assert URL/method/body. `mockFetch` for error-status cases.
- Web tests: `render`/`screen` from `@testing-library/react`; spy on the `horizon` singleton's methods and mock `useActiveUser`.
- `users.delete(id)` already exists — reuse it for "remove member" (no new method).
- Run from `apps/web`: `npx vitest run`, `npx tsc --noEmit`. From `libs/sdk`: same. Whole repo typecheck also fine.

**Out of scope:** any server change; PIN-per-profile; the unauthenticated pre-login `GET /users` privacy item; the Android client.

---

## File structure

**SDK (`libs/sdk/src/`)**
- `identity/household.ts` (new) — `HouseholdView`, `InviteKind`, `Invite` result types.
- `client/client.ts` — add `households` + `invites` namespaces; add `grant?` to `auth.pairApprove`.
- `index.ts` — export the new types.
- `client/client.test.ts` — method tests.

**Web (`apps/web/src/`)**
- `features/settings/components/HouseholdPanel.tsx` (+ `.css`, `.test.tsx`) — new.
- `features/settings/pages/Settings.tsx` — render `HouseholdPanel`.
- `features/identity/pages/Link.tsx` (+ `.test.tsx`) — grant selection.
- `features/identity/pages/Redeem.tsx` (+ `.css`, `.test.tsx`) — new.
- `shared/App.tsx` — public `/join` route + Guard exclusion.

---

# Phase 1 — SDK

### Task 1: `households` namespace + types

**Files:**
- Create: `libs/sdk/src/identity/household.ts`
- Modify: `libs/sdk/src/client/client.ts`, `libs/sdk/src/index.ts`
- Test: `libs/sdk/src/client/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `libs/sdk/src/client/client.test.ts`:

```typescript
describe('households', () => {
  it('me() GETs /api/households/me', async () => {
    const fn = spyFetch({ id: 'h1', name: 'Home', ownerUserId: 'u1', members: [] })
    const c = new HorizonClient({ baseUrl: '' })
    const h = await c.households.me()
    expect(fn).toHaveBeenCalledWith('/api/households/me', expect.objectContaining({ credentials: 'include' }))
    expect(h.name).toBe('Home')
  })

  it('rename() PATCHes /api/households/:id with the new name', async () => {
    const fn = spyFetch({ id: 'h1', name: 'Den', ownerUserId: 'u1', members: [] })
    const c = new HorizonClient({ baseUrl: '' })
    await c.households.rename('h1', 'Den')
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/households/h1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'Den' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t households`
Expected: FAIL — `c.households` is undefined.

- [ ] **Step 3: Implement**

Create `libs/sdk/src/identity/household.ts`:

```typescript
import type { User } from './user.ts'

/** A household with its members, as returned by GET /households/me. */
export interface HouseholdView {
  id: string
  name: string
  ownerUserId: string | null
  members: User[]
}

export type InviteKind = 'join' | 'new_household'

/** Result of POST /invites — a short-lived, single-use code. */
export interface InviteResult {
  code: string
  expiresAt: number
}
```

In `libs/sdk/src/client/client.ts`, add the import near the other identity imports:

```typescript
import type { HouseholdView, InviteKind, InviteResult } from '../identity/household.ts'
```

Add a `households` namespace (place it after the `users` namespace):

```typescript
  readonly households = {
    /** The caller's household + its members. */
    me: () => this.fetch<HouseholdView>('/households/me'),
    /** Rename a household (household owner or server owner/admin). */
    rename: (id: string, name: string) =>
      this.fetch<HouseholdView>(`/households/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  }
```

In `libs/sdk/src/index.ts`, export the new types:

```typescript
export type { HouseholdView, InviteKind, InviteResult } from './identity/household.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t households`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sdk/src/identity/household.ts libs/sdk/src/client/client.ts libs/sdk/src/index.ts libs/sdk/src/client/client.test.ts
git commit -m "feat(sdk): households namespace (me + rename)"
```

---

### Task 2: `invites` namespace

**Files:**
- Modify: `libs/sdk/src/client/client.ts`
- Test: `libs/sdk/src/client/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client.test.ts`:

```typescript
describe('invites', () => {
  it('create() POSTs /api/invites with the kind', async () => {
    const fn = spyFetch({ code: 'ABCD-2345', expiresAt: 123 })
    const c = new HorizonClient({ baseUrl: '' })
    const res = await c.invites.create({ kind: 'join' })
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/invites')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ kind: 'join' })
    expect(res.code).toBe('ABCD-2345')
  })

  it('redeem() POSTs /api/invites/redeem and stores the returned token', async () => {
    const fn = spyFetch({ token: 'tok-1', user: { id: 'u9', name: 'Friend' } })
    const c = new HorizonClient({ baseUrl: '' })
    const res = await c.invites.redeem({ code: 'ABCD-2345', name: 'Friend', password: 'longenough12' })
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/invites/redeem')
    expect(JSON.parse(init.body)).toEqual({ code: 'ABCD-2345', name: 'Friend', password: 'longenough12' })
    expect(res.token).toBe('tok-1')
    expect(c.getToken()).toBe('tok-1')   // native clients ride the stored token
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t invites`
Expected: FAIL — `c.invites` undefined.

- [ ] **Step 3: Implement**

In `client.ts`, add the `invites` namespace after `households` (import `AuthSession` is already present):

```typescript
  readonly invites = {
    /** Mint a single-use invite. `new_household` is server owner/admin only;
     *  `join` is the household owner's (server re-checks). */
    create: (body: { kind: InviteKind }) =>
      this.fetch<InviteResult>('/invites', { method: 'POST', body: JSON.stringify(body) }),
    /** Redeem an invite to create the account + session. Unauthenticated. Stores
     *  the returned bearer token (native); the web also gets the hz_session cookie. */
    redeem: async (body: { code: string; name: string; password: string }): Promise<AuthSession> => {
      const res = await this.fetch<AuthSession>('/invites/redeem', { method: 'POST', body: JSON.stringify(body) })
      this.setToken(res.token)
      return res
    },
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t invites`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/sdk/src/client/client.ts libs/sdk/src/client/client.test.ts
git commit -m "feat(sdk): invites namespace (create + redeem)"
```

---

### Task 3: `auth.pairApprove` grant parameter

**Files:**
- Modify: `libs/sdk/src/client/client.ts`
- Test: `libs/sdk/src/client/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client.test.ts`:

```typescript
describe('auth.pairApprove grant', () => {
  it('omits grant from the body when not provided', async () => {
    const fn = spyFetch({ ok: true })
    const c = new HorizonClient({ baseUrl: '' })
    await c.auth.pairApprove('ABCD-1234')
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ code: 'ABCD-1234' })
  })

  it('includes grant in the body when provided', async () => {
    const fn = spyFetch({ ok: true })
    const c = new HorizonClient({ baseUrl: '' })
    await c.auth.pairApprove('ABCD-1234', ['u1', 'u2'])
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ code: 'ABCD-1234', grant: ['u1', 'u2'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t "pairApprove grant"`
Expected: FAIL — grant is ignored (current signature is `(code)`).

- [ ] **Step 3: Implement**

In `client.ts`, replace the existing `pairApprove`:

```typescript
    /** Approve a pairing code from an already-authenticated phone/web client.
     *  `grant` is the set of profile ids the linked device may act as (a subset
     *  of the approver's household); omitted → the server grants the approver
     *  only (or, for a household owner, the whole household). */
    pairApprove: (code: string, grant?: string[]) =>
      this.fetch<{ ok: true }>('/auth/pair/approve', {
        method: 'POST',
        body: JSON.stringify(grant ? { code, grant } : { code }),
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/sdk && npx vitest run src/client/client.test.ts -t "pairApprove grant"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd libs/sdk && npx tsc --noEmit` → PASS.

```bash
git add libs/sdk/src/client/client.ts libs/sdk/src/client/client.test.ts
git commit -m "feat(sdk): auth.pairApprove accepts an act-as grant"
```

---

# Phase 2 — Web UI

### Task 4: HouseholdPanel component

**Files:**
- Create: `apps/web/src/features/settings/components/HouseholdPanel.tsx`, `HouseholdPanel.css`
- Test: `apps/web/src/features/settings/components/HouseholdPanel.test.tsx`

**Context:** A self-contained panel that loads `households.me()` and renders members + owner-only controls (rename, remove member, generate invites). It takes the current user + role via props so it stays easy to test (the parent `Settings.tsx` passes them from `useActiveUser`). Server is the real authority; client gating only hides controls.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/settings/components/HouseholdPanel.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { horizon } from '../../../shared/horizon.ts'
import HouseholdPanel from './HouseholdPanel'

const HOME = {
  id: 'h1', name: 'Home', ownerUserId: 'owner',
  members: [
    { id: 'owner', name: 'Owner', avatar: null, role: 'owner' },
    { id: 'partner', name: 'Partner', avatar: null, role: 'member' },
  ],
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'me').mockResolvedValue(HOME as any)
})

describe('HouseholdPanel', () => {
  it('renders the household name and members', async () => {
    render(<HouseholdPanel viewerId="partner" viewerRole="member" />)
    expect(await screen.findByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Partner')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
  })

  it('hides owner controls from a non-owner member', async () => {
    render(<HouseholdPanel viewerId="partner" viewerRole="member" />)
    await screen.findByText('Home')
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /invite a member/i })).toBeNull()
  })

  it('shows owner controls to the household owner', async () => {
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    expect(screen.getByRole('button', { name: /rename/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /invite a member/i })).toBeInTheDocument()
  })

  it('generates a join invite and shows a shareable link', async () => {
    vi.spyOn(horizon.invites, 'create').mockResolvedValue({ code: 'ABCD-2345', expiresAt: Date.now() + 86400000 })
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    screen.getByRole('button', { name: /invite a member/i }).click()
    expect(await screen.findByText(/\/join\?code=ABCD-2345/)).toBeInTheDocument()
    expect(horizon.invites.create).toHaveBeenCalledWith({ kind: 'join' })
  })

  it('surfaces a forbidden error when removing a member fails', async () => {
    vi.spyOn(horizon.users, 'delete').mockRejectedValue(Object.assign(new Error('x'), { code: 'caller-forbidden' }))
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    // remove the non-owner member, confirm, expect an inline error and the row remaining
    screen.getByRole('button', { name: /remove partner/i }).click()
    screen.getByRole('button', { name: /^confirm$/i }).click()
    expect(await screen.findByText(/not allowed/i)).toBeInTheDocument()
    expect(screen.getByText('Partner')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/features/settings/components/HouseholdPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/web/src/features/settings/components/HouseholdPanel.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView } from '@horizon/sdk'
import './HouseholdPanel.css'

interface Props {
  viewerId: string
  viewerRole: 'owner' | 'admin' | 'member'
}

function inviteLink(code: string): string {
  return `${window.location.origin}/join?code=${code}`
}

export default function HouseholdPanel({ viewerId, viewerRole }: Props) {
  const [household, setHousehold] = useState<HouseholdView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setHousehold(await horizon.households.me()) }
    catch { setLoadError(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const isHouseholdOwner = !!household && household.ownerUserId === viewerId
  const isServerAdmin = viewerRole === 'owner' || viewerRole === 'admin'

  async function rename() {
    if (!household || !nameDraft.trim()) return
    setBusy(true); setActionError(null)
    try {
      const updated = await horizon.households.rename(household.id, nameDraft.trim())
      setHousehold(updated); setRenaming(false)
    } catch { setActionError('Could not rename the household.') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true); setActionError(null); setConfirmRemove(null)
    try {
      await horizon.users.delete(id)
      await load()
    } catch (e) {
      const code = (e as { code?: string }).code
      setActionError(code === 'owner-protected' ? 'The household owner cannot be removed.' : 'Not allowed to remove that member.')
    } finally { setBusy(false) }
  }

  async function generate(kind: 'join' | 'new_household') {
    setBusy(true); setActionError(null); setLink(null)
    try {
      const { code } = await horizon.invites.create({ kind })
      setLink(inviteLink(code))
    } catch { setActionError('Could not create an invite.') }
    finally { setBusy(false) }
  }

  if (loadError) return (
    <section className="settings__section">
      <p className="settings__section-title">Household</p>
      <p className="settings__profile-error">Couldn’t load your household.</p>
    </section>
  )
  if (!household) return (
    <section className="settings__section">
      <p className="settings__section-title">Household</p>
      <p className="hh__muted">Loading…</p>
    </section>
  )

  return (
    <section className="settings__section">
      <p className="settings__section-title">Household</p>

      <div className="hh__name-row">
        {renaming ? (
          <>
            <input className="settings__input" value={nameDraft} onChange={e => setNameDraft(e.target.value)} aria-label="Household name" />
            <button className="settings__token-replace" disabled={busy} onClick={rename}>Save</button>
            <button className="settings__token-cancel" onClick={() => setRenaming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <span className="hh__name">{household.name}</span>
            {isHouseholdOwner && (
              <button className="settings__token-replace" onClick={() => { setNameDraft(household.name); setRenaming(true) }}>Rename</button>
            )}
          </>
        )}
      </div>

      <ul className="hh__members">
        {household.members.map(m => {
          const removable = isHouseholdOwner && m.id !== viewerId && m.id !== household.ownerUserId
          return (
            <li key={m.id} className="hh__member">
              <span className="hh__member-name">{m.name}</span>
              <span className="hh__member-role">{m.role}</span>
              {removable && (
                confirmRemove === m.id ? (
                  <span className="hh__confirm">
                    <button className="settings__token-replace" disabled={busy} onClick={() => remove(m.id)}>Confirm</button>
                    <button className="settings__token-cancel" onClick={() => setConfirmRemove(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="settings__token-cancel" aria-label={`Remove ${m.name}`} onClick={() => setConfirmRemove(m.id)}>Remove</button>
                )
              )}
            </li>
          )
        })}
      </ul>

      <div className="hh__invites">
        {isHouseholdOwner && (
          <button className="settings__token-replace" disabled={busy} onClick={() => generate('join')}>Invite a member</button>
        )}
        {isServerAdmin && (
          <button className="settings__token-replace" disabled={busy} onClick={() => generate('new_household')}>Invite a new household</button>
        )}
        {link && (
          <div className="hh__link">
            <code>{link}</code>
            <button className="settings__token-replace" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
            <span className="hh__muted">Expires in 24h</span>
          </div>
        )}
      </div>

      {actionError && <p className="settings__profile-error">{actionError}</p>}
    </section>
  )
}
```

`apps/web/src/features/settings/components/HouseholdPanel.css`:

```css
.hh__name-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.hh__name { font-weight: 600; }
.hh__members { list-style: none; padding: 0; margin: 0 0 12px; }
.hh__member { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.hh__member-name { flex: 1; }
.hh__member-role { opacity: 0.6; font-size: 0.85em; text-transform: capitalize; }
.hh__confirm { display: inline-flex; gap: 6px; }
.hh__invites { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.hh__link { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.hh__muted { opacity: 0.6; font-size: 0.85em; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/features/settings/components/HouseholdPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/settings/components/HouseholdPanel.tsx apps/web/src/features/settings/components/HouseholdPanel.css apps/web/src/features/settings/components/HouseholdPanel.test.tsx
git commit -m "feat(web): HouseholdPanel — members, rename, remove, invites"
```

---

### Task 5: Render HouseholdPanel in Settings

**Files:**
- Modify: `apps/web/src/features/settings/pages/Settings.tsx`

- [ ] **Step 1: Implement**

In `Settings.tsx`, import the panel:

```tsx
import HouseholdPanel from '../components/HouseholdPanel'
```

The component already resolves the viewer via the page's existing `useActiveUser`/role state (it reads `viewerId` and `viewerRole` — the file already has a `viewerRole` value and the active user id; reuse them). Render the panel as a section — place it right after the existing **Profiles** section block:

```tsx
{activeUser && <HouseholdPanel viewerId={activeUser.id} viewerRole={viewerRole} />}
```

> Use whatever the file already calls the active user (e.g. `user`/`activeUser` from `useActiveUser`) and its existing `viewerRole`. If the active-user variable has a different name, match it.

- [ ] **Step 2: Build + typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the settings tests (no regressions)**

Run: `cd apps/web && npx vitest run src/features/settings`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/settings/pages/Settings.tsx
git commit -m "feat(web): mount HouseholdPanel in Settings"
```

---

### Task 6: Grant selection in Link.tsx

**Files:**
- Modify: `apps/web/src/features/identity/pages/Link.tsx`
- Test: `apps/web/src/features/identity/pages/Link.test.tsx` (new)

**Context:** When the approver is their household's owner, show a member checklist (all checked) and pass the selected ids as the grant. A plain member approves with no grant (server grants self). The approver's role/id come from `useActiveUser`; members come from `households.me()`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/identity/pages/Link.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Link from './Link'

const HOME = {
  id: 'h1', name: 'Home', ownerUserId: 'owner',
  members: [
    { id: 'owner', name: 'Owner', avatar: null, role: 'owner' },
    { id: 'partner', name: 'Partner', avatar: null, role: 'member' },
  ],
}

vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({ user: globalThis.__viewer, userId: globalThis.__viewer?.id, loading: false, refresh: vi.fn() }),
}))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'me').mockResolvedValue(HOME as any)
  vi.spyOn(horizon.auth, 'pairApprove').mockResolvedValue({ ok: true } as any)
})

function renderLink() {
  return render(<MemoryRouter><Link /></MemoryRouter>)
}

describe('Link grant selection', () => {
  it('owner: renders a member checklist (all checked) and sends selected ids as grant', async () => {
    ;(globalThis as any).__viewer = { id: 'owner', role: 'member', householdId: 'h1' }
    renderLink()
    await screen.findByText('Partner')
    await userEvent.type(screen.getByLabelText(/code/i), 'ABCD1234')
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    await waitFor(() => expect(horizon.auth.pairApprove).toHaveBeenCalledWith('ABCD-1234', expect.arrayContaining(['owner', 'partner'])))
  })

  it('member: no checklist, approves without a grant', async () => {
    ;(globalThis as any).__viewer = { id: 'partner', role: 'member', householdId: 'h1' }
    renderLink()
    await userEvent.type(screen.getByLabelText(/code/i), 'ABCD1234')
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    await waitFor(() => expect(horizon.auth.pairApprove).toHaveBeenCalledWith('ABCD-1234'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/features/identity/pages/Link.test.tsx`
Expected: FAIL — no checklist; `pairApprove` called without grant for the owner.

- [ ] **Step 3: Implement**

Edit `Link.tsx`. Add imports + state for members/selection, load members when the viewer is their household owner, render the checklist, and pass the grant.

Add near the top imports:

```tsx
import { useEffect } from 'react'
import type { HouseholdView } from '@horizon/sdk'
```

Inside the component, after the existing state, add:

```tsx
  const [household, setHousehold] = useState<HouseholdView | null>(null)
  const [granted, setGranted] = useState<Set<string>>(new Set())

  const isHouseholdOwner = !!household && !!user && household.ownerUserId === user.id

  useEffect(() => {
    let live = true
    horizon.households.me()
      .then(h => { if (live) { setHousehold(h); setGranted(new Set(h.members.map(m => m.id))) } })
      .catch(() => { /* not fatal — fall back to a self-only approve */ })
    return () => { live = false }
  }, [])
```

In `approve()`, replace the `pairApprove(trimmed)` call:

```tsx
      if (isHouseholdOwner) {
        const ids = [...granted]
        if (ids.length === 0) { setError('Select at least one profile for this TV.'); setBusy(false); return }
        await horizon.auth.pairApprove(trimmed, ids)
      } else {
        await horizon.auth.pairApprove(trimmed)
      }
```

Render the checklist (only when `isHouseholdOwner`) above the Link button:

```tsx
      {isHouseholdOwner && household && (
        <fieldset className="link__grant">
          <legend>Which profiles can use this TV?</legend>
          {household.members.map(m => (
            <label key={m.id} className="link__grant-row">
              <input
                type="checkbox"
                checked={granted.has(m.id)}
                onChange={e => setGranted(prev => {
                  const next = new Set(prev)
                  if (e.target.checked) next.add(m.id); else next.delete(m.id)
                  return next
                })}
              />
              {m.name}
            </label>
          ))}
        </fieldset>
      )}
```

Ensure the code input has an accessible label (`aria-label="Code"` or a `<label>`), and the submit control is a `<button>` reading "Link" — match the file's existing markup; add `aria-label`/text only if missing so the test's `getByLabelText(/code/i)` and `getByRole('button', { name: /link/i })` resolve.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/features/identity/pages/Link.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/identity/pages/Link.tsx apps/web/src/features/identity/pages/Link.test.tsx
git commit -m "feat(web): grant selection in TV pairing approval"
```

---

### Task 7: Redeem page + `/join` route

**Files:**
- Create: `apps/web/src/features/identity/pages/Redeem.tsx`, `Redeem.css`
- Test: `apps/web/src/features/identity/pages/Redeem.test.tsx`
- Modify: `apps/web/src/shared/App.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/identity/pages/Redeem.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Redeem from './Redeem'

const refresh = vi.fn().mockResolvedValue(undefined)
vi.mock('../hooks/useActiveUser.ts', () => ({ useActiveUser: () => ({ refresh }) }))

beforeEach(() => { vi.restoreAllMocks(); refresh.mockClear() })

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/join" element={<Redeem />} />
        <Route path="/" element={<div>LIBRARY</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Redeem', () => {
  it('prefills the code from ?code and redeems → navigates home', async () => {
    vi.spyOn(horizon.invites, 'redeem').mockResolvedValue({ token: 't', user: { id: 'u9' } } as any)
    renderAt('/join?code=ABCD-2345')
    expect((screen.getByLabelText(/code/i) as HTMLInputElement).value).toContain('ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'longenough12')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    await waitFor(() => expect(screen.getByText('LIBRARY')).toBeInTheDocument())
    expect(refresh).toHaveBeenCalled()
  })

  it('shows an expired message for an expired invite', async () => {
    vi.spyOn(horizon.invites, 'redeem').mockRejectedValue(Object.assign(new Error('x'), { code: 'invite-expired' }))
    renderAt('/join?code=ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'longenough12')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    expect(await screen.findByText(/expired/i)).toBeInTheDocument()
  })

  it('blocks a short password client-side', async () => {
    const spy = vi.spyOn(horizon.invites, 'redeem')
    renderAt('/join?code=ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'short')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    expect(await screen.findByText(/at least 8/i)).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/features/identity/pages/Redeem.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/web/src/features/identity/pages/Redeem.tsx`:

```tsx
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import './Redeem.css'

const MIN_PASSWORD_LEN = 8

function formatCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

function messageFor(code: string | undefined): string {
  switch (code) {
    case 'invite-not-found': return 'That invite is invalid.'
    case 'invite-expired': return 'That invite has expired — ask for a new one.'
    case 'name-taken': return 'That name is taken — try another.'
    case 'weak-password': return 'Use at least 8 characters.'
    case 'rate-limited': return 'Too many attempts — wait a moment and retry.'
    default: return 'Could not redeem the invite.'
  }
}

export default function Redeem() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { refresh } = useActiveUser()
  const [code, setCode] = useState(formatCode(params.get('code') ?? ''))
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (password.length < MIN_PASSWORD_LEN) { setError('Use at least 8 characters.'); return }
    if (!name.trim() || code.replace(/[^A-Z0-9]/g, '').length < 8) { setError('Enter the invite code and a name.'); return }
    setBusy(true); setError(null)
    try {
      await horizon.invites.redeem({ code, name: name.trim(), password })
      await refresh()
      navigate('/', { replace: true })
    } catch (e) {
      setError(messageFor((e as { code?: string }).code))
    } finally { setBusy(false) }
  }

  return (
    <div className="redeem">
      <div className="redeem__card">
        <h1>Join the server</h1>
        <label className="redeem__label">Invite code
          <input className="redeem__input" value={code} onChange={e => setCode(formatCode(e.target.value))} />
        </label>
        <label className="redeem__label">Your name
          <input className="redeem__input" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="redeem__label">Password
          <input className="redeem__input" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        <button className="redeem__submit" disabled={busy} onClick={submit}>Create account</button>
        {error && <p className="redeem__error">{error}</p>}
      </div>
    </div>
  )
}
```

`apps/web/src/features/identity/pages/Redeem.css`:

```css
.redeem { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.redeem__card { width: min(360px, 90vw); display: flex; flex-direction: column; gap: 12px; padding: 32px; }
.redeem__label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; }
.redeem__input { padding: 8px 10px; }
.redeem__submit { padding: 10px; margin-top: 8px; }
.redeem__error { color: var(--danger, #e25); font-size: 0.9em; }
```

In `apps/web/src/shared/App.tsx`: import `Redeem` and register a **public** route (no `<Guard>`), and ensure the Guard never bounces `/join`. Add to the imports and the `<Routes>`:

```tsx
import Redeem from '../features/identity/pages/Redeem'
// ...
      <Route path="/join" element={<Redeem />} />
```

In the `Guard` component, add `/join` to the public-path conditions so an unauthenticated visitor isn't redirected. The Guard currently special-cases `/login` and `/setup`; extend each relevant check to also treat `/join` as public — e.g. change the redirect conditions:

```tsx
  const PUBLIC = ['/login', '/setup', '/join']
  // ...
  if (hasUsers && !user && !PUBLIC.includes(location.pathname)) {
    return <Navigate to="/login" replace />
  }
  if (user && !user.hasPassword && !PUBLIC.includes(location.pathname)) {
    return <Navigate to="/login" replace />
  }
```

> Match the Guard's existing structure; the key requirement is that `/join` is reachable with no session. The route element itself is unwrapped (no `<Guard>`), which is the primary guarantee; the PUBLIC list keeps the first-run/`hasUsers` checks from redirecting it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/features/identity/pages/Redeem.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/identity/pages/Redeem.tsx apps/web/src/features/identity/pages/Redeem.css apps/web/src/features/identity/pages/Redeem.test.tsx apps/web/src/shared/App.tsx
git commit -m "feat(web): invite redeem page at /join"
```

---

## Final verification

- [ ] `cd libs/sdk && npx tsc --noEmit && npx vitest run` → all pass.
- [ ] `cd apps/web && npx tsc --noEmit && npx vitest run` → all pass.
- [ ] Manual smoke (optional, needs a running server + web): as owner, open Settings → Household → generate a join invite → open the link in a private window → redeem → land in the library; then open `/link`, enter a TV code, confirm the profile checklist appears.

## Notes for the implementer

- The web and SDK are one repo; when you change the SDK, the web picks it up via the workspace symlink — no publish step. Run both test suites.
- `useActiveUser` already exposes `refresh()` (re-runs `auth.me()`); the redeem flow uses it so the app re-resolves identity from the new session cookie before navigating.
- Keep client-side role gating as convenience only — every action must still succeed/fail on the server's response; tests assert the forbidden/expired paths.
