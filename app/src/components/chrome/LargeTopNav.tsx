import { useNavigate } from 'react-router-dom'
import HorizonMark from './HorizonMark.tsx'
import Icon from './Icon.tsx'
import ProfileBadgeButton from './ProfileBadgeButton.tsx'
import './LargeTopNav.css'

export type TabKey = 'Home' | 'Movies' | 'Series' | 'Collections'

interface Props {
  /** Which tab should render as the selected pill. Omit on screens that aren't
   *  a root tab (e.g. show detail, player) to leave all pills inactive. */
  active?: TabKey
  /** When true, chrome floats over the hero art with a dark-fade scrim at top
   *  instead of a solid bar. The scrim is mandatory for readability —
   *  controls sit over bright posters / dune-sun orange without it. */
  transparent?: boolean
  /** When set, the logo slot is replaced by a back button routing here. */
  back?: string
}

/** The primary chrome: logo · tabs · search · profile. Sticks to the top of
 *  every app surface. Scales are intentionally generous (72px height) because
 *  this is a desktop / tablet web app — the Nunito type needs room. */
export default function LargeTopNav({ active, transparent = false, back }: Props) {
  const navigate = useNavigate()
  const tabs: { key: TabKey; href: string }[] = [
    { key: 'Home',        href: '/?tab=movies' },
    { key: 'Movies',      href: '/?tab=movies' },
    { key: 'Series',      href: '/?tab=shows' },
    { key: 'Collections', href: '/?tab=collections' },
  ]

  return (
    <div className={`top-nav ${transparent ? 'top-nav--transparent' : ''}`}>
      {transparent && <div className="top-nav__scrim" />}
      <div className="top-nav__inner">
        {back ? (
          <button className="top-nav__icon-btn" onClick={() => navigate(back)} aria-label="Back">
            <Icon name="back" size={16} />
          </button>
        ) : (
          <button
            className="top-nav__logo"
            onClick={() => navigate('/')}
            aria-label="Horizon"
            style={{ background: 'transparent', border: 'none', padding: 0 }}
          >
            <HorizonMark size={36} />
          </button>
        )}

        <div className="top-nav__tabs">
          {tabs.map(t => (
            <button
              key={t.key}
              className={`top-nav__tab ${active === t.key ? 'is-active' : ''}`}
              onClick={() => navigate(t.href)}
            >
              {t.key}
            </button>
          ))}
        </div>

        <div className="top-nav__spacer" />

        <button className="top-nav__icon-btn" aria-label="Search">
          <Icon name="search" size={16} />
        </button>
        <ProfileBadgeButton />
      </div>
    </div>
  )
}
