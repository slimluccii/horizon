import { useNavigate } from 'react-router-dom'
import { useActiveUser } from '../hooks/useActiveUser.ts'

/** The picker of a shared device: pick a profile and go. */
export default function Profiles() {
  const navigate = useNavigate()
  const { profiles, pickProfile } = useActiveUser()

  async function pick(id: string) {
    await pickProfile(id)
    navigate('/', { replace: true })
  }

  return (
    <main>
      <h1>Who's watching?</h1>
      <ul>
        {profiles.map(p => (
          <li key={p.id}>
            <button type="button" onClick={() => pick(p.id)}>
              <span aria-hidden="true">{p.avatar ?? p.name.charAt(0).toUpperCase()}</span>
              <span>{p.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
