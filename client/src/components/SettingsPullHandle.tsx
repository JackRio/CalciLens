import { useEffect, useRef } from 'react'

// A thread with a knob at the bottom-middle of the empty viewer: pull it up
// (or just click it) and the settings panel slides open. It bobs gently so it
// reads as something you can grab.
export default function SettingsPullHandle({ onOpen }: { onOpen: () => void }) {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  function onMouseDown(e: React.MouseEvent) {
    // The viewer underneath treats a press as the start of a pan.
    e.stopPropagation()
    const startY = e.clientY
    const move = (ev: MouseEvent) => {
      if (startY - ev.clientY > 20) {
        stop()
        onOpen()
      }
    }
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      cleanup.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    cleanup.current = stop
  }

  return (
    <button
      type="button"
      className="pull-handle"
      aria-label="Open settings"
      title="Pull up for settings"
      onMouseDown={onMouseDown}
      onClick={onOpen}
    >
      <svg width="64" height="86" viewBox="0 0 64 86" fill="none" aria-hidden>
        <g className="pull-handle-bob" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16 L32 6 L42 16" />
          <path d="M22 28 L32 18 L42 28" opacity="0.5" />
          <path d="M32 86 C 24 72, 40 62, 32 48" />
          <circle cx="32" cy="42" r="7" fill="#14151a" />
        </g>
      </svg>
    </button>
  )
}
