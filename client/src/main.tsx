import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import type { AppMode } from './types.ts'
import Launcher from './components/Launcher.tsx'

function Root() {
  const [choice, setChoice] = useState<{ mode: AppMode; panes: 1 | 2 } | null>(null)
  const mode = choice?.mode ?? null
  // On the mode-selection screen there is nothing to lose, so closing the
  // window is answered at once (a screen with work open answers for itself).
  useEffect(() => {
    if (mode !== null || window.location.hash === '#app') return
    const api = window.electronAPI
    if (!api?.onCloseRequested) return
    return api.onCloseRequested(() => {
      api.closeAck()
      api.confirmClose()
    })
  }, [mode])
  // The full, unrestricted app is still reachable at /#app while the other modes are built.
  if (window.location.hash === '#app') return <App />
  if (!choice) return <Launcher onSelect={(m, panes = 1) => setChoice({ mode: m, panes })} />
  return <App mode={choice.mode} initialPaneCount={choice.panes} onExit={() => setChoice(null)} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
