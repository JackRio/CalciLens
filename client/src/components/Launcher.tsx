import { useState } from 'react'
import './Launcher.css'
import type { AppMode } from '../types'

type Layout = 'single' | 'split'

interface ModeCardProps {
  onSelect?: () => void
  icon: string
  title: string
  hint: string
  children?: React.ReactNode
}

function ModeCard({ icon, title, hint, onSelect, children }: ModeCardProps) {
  return (
    <div className="launcher-card">
      <button className="launcher-card-main" type="button" onClick={onSelect}>
        <span className="launcher-icon">{icon}</span>
        <span className="launcher-title">{title}</span>
        <span className="launcher-hint">{hint}</span>
      </button>
      {children}
    </div>
  )
}

export default function Launcher({ onSelect }: { onSelect: (mode: AppMode) => void }) {
  const [layout, setLayout] = useState<Layout>('single')

  return (
    <div className="launcher">
      <h1 className="launcher-brand">CT Viewer</h1>

      <div className="launcher-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={layout === 'single'}
          className={layout === 'single' ? 'active' : ''}
          onClick={() => setLayout('single')}
        >
          Single screen
        </button>
        <button
          role="tab"
          aria-selected={layout === 'split'}
          className={layout === 'split' ? 'active' : ''}
          onClick={() => setLayout('split')}
        >
          Split view
        </button>
      </div>

      {layout === 'single' ? (
        <div className="launcher-grid">
          <ModeCard icon="👁" title="View" hint="Look only" onSelect={() => onSelect('view')} />
          <ModeCard icon="💬" title="Review" hint="Comment or edit annotations" />
          <ModeCard icon="✏️" title="Annotate" hint="Semi-automated / Manual annotations">
            <div className="launcher-sub">
              <button type="button">Contrast</button>
              <button type="button" onClick={() => onSelect('annotate-noncontrast')}>
                Non-contrast
              </button>
            </div>
          </ModeCard>
        </div>
      ) : (
        <div className="launcher-grid launcher-grid-one">
          <ModeCard icon="💬" title="Review" hint="Compare two scans" />
        </div>
      )}
    </div>
  )
}
