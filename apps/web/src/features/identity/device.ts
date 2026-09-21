// Per-device conveniences. They are safe to lose: the worst case is one extra question or one extra pick.
const ASKED_KEY = 'horizon.deviceAsked'
const PROFILE_KEY = 'horizon.profile'

function read(storage: () => Storage, key: string): string | null {
  try { return storage().getItem(key) } catch { return null }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch { /* private window or blocked storage */ }
}

export const wasDeviceAsked = () => read(() => localStorage, ASKED_KEY) === '1'
export const markDeviceAsked = () => write(() => localStorage, ASKED_KEY, '1')

// sessionStorage, so a shared device asks who is watching every time it is opened.
export const pickedProfile = () => read(() => sessionStorage, PROFILE_KEY)
export const rememberPickedProfile = (id: string | null) => write(() => sessionStorage, PROFILE_KEY, id)
