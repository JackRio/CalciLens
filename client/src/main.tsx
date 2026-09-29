import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import type { AppMode } from './types.ts'
import Launcher from './components/Launcher.tsx'

function Root() {
  const [mode, setMode] = useState<AppMode | null>(null)
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
  if (!mode) return <Launcher onSelect={setMode} />
  return <App mode={mode} onExit={() => setMode(null)} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
