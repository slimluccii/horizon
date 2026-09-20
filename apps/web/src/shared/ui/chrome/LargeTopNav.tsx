import { useNavigate } from 'react-router-dom'
import HorizonMark from './HorizonMark.tsx'
import Icon from './Icon.tsx'
import ProfileBadgeButton from './ProfileBadgeButton.tsx'
export type TabKey = 'Home' | 'Movies' | 'Series' | 'Collections'

interface Props {
  /** Which tab is the current page. Omit on screens that aren't a root tab
   *  (e.g. show detail, player) to leave all tabs unselected. */
  active?: TabKey
  /** Kept for callers rendering over hero art; purely a styling hint, unused
   *  until the visual design layer returns. */
  transparent?: boolean
  /** When set, the logo slot is replaced by a back button routing here. */
  back?: string
}

/** The primary chrome: logo · tabs · search · profile. */
export default function LargeTopNav({ active, back }: Props) {
  const navigate = useNavigate()
  const tabs: { key: TabKey; href: string }[] = [
    { key: 'Home',        href: '/?tab=movies' },
    { key: 'Movies',      href: '/?tab=movies' },
    { key: 'Series',      href: '/?tab=shows' },
    { key: 'Collections', href: '/?tab=collections' },
  ]

  return (
    <header>
      {back ? (
        <button onClick={() => navigate(back)} aria-label="Back">
          <Icon name="back" size={16} />
        </button>
      ) : (
        <button
          onClick={() => navigate('/')}
          aria-label="Horizon"
        >
          <HorizonMark size={36} />
        </button>
      )}

      <nav aria-label="Library sections">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => navigate(t.href)}
            aria-current={active === t.key ? 'page' : undefined}
          >
            {t.key}
          </button>
        ))}
      </nav>

      <button onClick={() => navigate('/search')} aria-label="Search">
        <Icon name="search" size={16} />
      </button>
      <ProfileBadgeButton />
    </header>
  )
}
