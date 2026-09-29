import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import type { AppMode } from './App.tsx'
import Launcher from './components/Launcher.tsx'

function Root() {
  const [mode, setMode] = useState<AppMode | null>(null)
  // The full, unrestricted app is still reachable at /#app while the other modes are built.
  if (window.location.hash === '#app') return <App />
  if (!mode) return <Launcher onView={() => setMode('view')} />
  return <App mode={mode} onExit={() => setMode(null)} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
