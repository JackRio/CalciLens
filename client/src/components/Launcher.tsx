import { useEffect, useRef, useState } from 'react'
import './Launcher.css'
import type { AppMode } from '../types'
import { AppLogo, LauncherPreview, type PreviewId } from './LauncherPreviews'

interface ModeCardProps {
  icon: string
  title: string
  hint: string
  // A card with its own buttons (View, Annotate) is just a label; only a card
  // with nothing underneath is clickable as a whole.
  onSelect?: () => void
  // Props that make hovering/focusing this card show its drawing.
  previewProps?: PreviewHandlers
  children?: React.ReactNode
}

interface PreviewHandlers {
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: () => void
}

function ModeCard({ icon, title, hint, onSelect, previewProps, children }: ModeCardProps) {
  const face = (
    <>
      <span className="launcher-icon">{icon}</span>
      <span className="launcher-title">{title}</span>
      <span className="launcher-hint">{hint}</span>
    </>
  )
  return (
    <div className="launcher-card" {...previewProps}>
      {onSelect ? (
        <button className="launcher-card-main" type="button" onClick={onSelect}>
          {face}
        </button>
      ) : (
        <div className="launcher-card-main launcher-card-label">{face}</div>
      )}
      {children}
    </div>
  )
}

export default function Launcher({ onSelect }: { onSelect: (mode: AppMode, panes?: 1 | 2) => void }) {
  // Which option's drawing is showing. Leaving an option clears it after a
  // short pause, so moving between neighbouring buttons doesn't flash the
  // idle drawing in the gap.
  const [preview, setPreview] = useState<PreviewId | null>(null)
  const clearTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (clearTimer.current) window.clearTimeout(clearTimer.current)
  }, [])

  function show(id: PreviewId) {
    if (clearTimer.current) window.clearTimeout(clearTimer.current)
    setPreview(id)
  }
  function hide() {
    if (clearTimer.current) window.clearTimeout(clearTimer.current)
    clearTimer.current = window.setTimeout(() => setPreview(null), 250)
  }
  // `parent` is the block a button belongs to: leaving the button falls back to
  // the block's general drawing (the pointer is still inside the block) rather
  // than to nothing.
  const hover = (id: PreviewId, parent?: PreviewId): PreviewHandlers => ({
    onMouseEnter: () => show(id),
    onMouseLeave: parent ? () => show(parent) : hide,
    onFocus: () => show(id),
    onBlur: parent ? () => show(parent) : hide,
  })

  return (
    <div className="launcher">
      <div className="launcher-brand-row">
        <AppLogo size={60} />
        <div>
          <h1 className="launcher-brand">
            Calci<span>Lens</span>
          </h1>
          <div className="launcher-tagline">see the calcium. score the calcium.</div>
        </div>
      </div>

      <div className="launcher-grid">
        <ModeCard icon="👁" title="View" hint="Look only" previewProps={hover('view')}>
          <div className="launcher-sub">
            <button type="button" onClick={() => onSelect('view', 1)} {...hover('view-single', 'view')}>
              Single screen
            </button>
            <button type="button" onClick={() => onSelect('view', 2)} {...hover('view-split', 'view')}>
              Split view
            </button>
          </div>
        </ModeCard>

        <ModeCard icon="💬" title="Review" hint="Comment or edit annotations" previewProps={hover('review')} />

        <ModeCard
          icon="✏️"
          title="Annotate"
          hint="Semi-automated / Manual annotations"
          previewProps={hover('annotate')}
        >
          <div className="launcher-sub">
            <button
              type="button"
              onClick={() => onSelect('annotate-contrast', 1)}
              {...hover('annotate-contrast', 'annotate')}
            >
              Contrast
            </button>
            <button
              type="button"
              onClick={() => onSelect('annotate-noncontrast', 1)}
              {...hover('annotate-noncontrast', 'annotate')}
            >
              Non-contrast
            </button>
          </div>
        </ModeCard>
      </div>

      <div className="launcher-stage">
        <LauncherPreview id={preview} />
      </div>
    </div>
  )
}
