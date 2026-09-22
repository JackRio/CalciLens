import { useState } from 'react'

const STORAGE_KEY = 'ctviewer.annotationSaveDir'

function loadAnnotationSaveDir(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

// '' means unset — saves fall back to the existing next-to-image behavior.
export function useAnnotationSaveDir(): [string, (next: string) => void] {
  const [dir, setDirState] = useState<string>(loadAnnotationSaveDir)

  function setDir(next: string) {
    setDirState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* localStorage unavailable (e.g. disabled) — keep working in-memory */
    }
  }

  return [dir, setDir]
}
