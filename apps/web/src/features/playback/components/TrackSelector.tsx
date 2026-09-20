import { useState } from 'react'
import type { AudioTrack, SubtitleTrack, QualityProfile } from '@horizon/sdk'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
interface QualityOption {
  label: string
  bitrate: number | 'auto'
}

const QUALITY_OPTIONS: QualityOption[] = [
  { label: 'Auto',  bitrate: 'auto' },
  { label: '4K',    bitrate: 40000  },
  { label: '1080p', bitrate: 8000   },
  { label: '720p',  bitrate: 4000   },
  { label: '480p',  bitrate: 2000   },
]

interface Props {
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  selectedAudio: number
  selectedSubtitle: number | null
  currentProfile: QualityProfile | null
  onAudioChange: (index: number) => void
  onSubtitleChange: (index: number | null) => void
  onQualityChange: (bitrate: number | 'auto') => void
  /** direct-play sessions can't swap quality / audio mid-stream. */
  isTranscode: boolean
}

function audioLabel(t: AudioTrack): string {
  const lang = t.language && t.language !== 'und' ? t.language.toUpperCase() : ''
  const ch = t.channels >= 6 ? `${t.channels}.1` : (t.channels === 2 ? 'Stereo' : `${t.channels}ch`)
  const parts = [lang, t.title || t.codec, ch].filter(Boolean)
  return parts.join(' · ')
}

function subtitleLabel(t: SubtitleTrack): string {
  const lang = t.language && t.language !== 'und' ? t.language.toUpperCase() : 'UND'
  const tags = [
    t.forced ? 'forced' : null,
    t.external ? 'external' : null,
    // Image-based (PGS/VobSub): server burns it into the video — selecting it
    // switches the session to transcode.
    !t.embeddable && !t.external ? 'burned in' : null,
  ].filter(Boolean)
  return tags.length ? `${lang} (${tags.join(', ')})` : lang
}

type OpenMenu = 'audio' | 'subtitle' | 'quality' | null

export default function TrackSelector({
  audioTracks, subtitleTracks, selectedAudio, selectedSubtitle, currentProfile,
  onAudioChange, onSubtitleChange, onQualityChange, isTranscode,
}: Props) {
  const [open, setOpen] = useState<OpenMenu>(null)
  const toggle = (m: OpenMenu) => setOpen(curr => curr === m ? null : m)

  const currentQualityLabel = (() => {
    if (!currentProfile?.height) return 'Auto'
    return `${currentProfile.height}p`
  })()

  const currentAudio = audioTracks.find(t => t.index === selectedAudio)
  const currentSub = selectedSubtitle == null ? null : subtitleTracks.find(t => t.index === selectedSubtitle)

  return (
    <div>
      {/* Quality */}
      {isTranscode && (
        <div>
          <button aria-expanded={open === 'quality'} onClick={() => toggle('quality')}>
            <Icon name="settings-slider" size={14} /> {currentQualityLabel}
            <Icon name="chevron-down" size={12} />
          </button>
          {open === 'quality' && (
            <div>
              <p>Quality</p>
              {QUALITY_OPTIONS.map(opt => {
                const active = opt.bitrate === 'auto'
                  ? false
                  : currentProfile?.videoBitrate === opt.bitrate
                return (
                  <button
                    key={opt.label}
                    aria-pressed={active}
                    onClick={() => { onQualityChange(opt.bitrate); setOpen(null) }}
                  >
                    {opt.label}
                    {active && <Icon name="check" size={12} />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Audio */}
      {audioTracks.length > 1 && (
        <div>
          <button aria-expanded={open === 'audio'} onClick={() => toggle('audio')}>
            <Icon name="audio" size={14} /> {currentAudio ? (currentAudio.language || 'Audio').toUpperCase() : 'Audio'}
            <Icon name="chevron-down" size={12} />
          </button>
          {open === 'audio' && (
            <div>
              <p>Audio track</p>
              {audioTracks.map(t => (
                <button
                  key={t.index}
                  aria-pressed={t.index === selectedAudio}
                  onClick={() => { onAudioChange(t.index); setOpen(null) }}
                >
                  {audioLabel(t)}
                  {t.index === selectedAudio && <Icon name="check" size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Subtitles */}
      {subtitleTracks.length > 0 && (
        <div>
          <button aria-expanded={open === 'subtitle'} onClick={() => toggle('subtitle')}>
            <Icon name="subtitle" size={14} /> {currentSub ? (currentSub.language || 'On').toUpperCase() : 'Off'}
            <Icon name="chevron-down" size={12} />
          </button>
          {open === 'subtitle' && (
            <div>
              <p>Subtitles</p>
              <button
                aria-pressed={selectedSubtitle == null}
                onClick={() => { onSubtitleChange(null); setOpen(null) }}
              >
                Off
                {selectedSubtitle == null && <Icon name="check" size={12} />}
              </button>
              {subtitleTracks.map(t => (
                <button
                  key={t.index}
                  aria-pressed={t.index === selectedSubtitle}
                  onClick={() => { onSubtitleChange(t.index); setOpen(null) }}
                >
                  {subtitleLabel(t)}
                  {t.index === selectedSubtitle && <Icon name="check" size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
