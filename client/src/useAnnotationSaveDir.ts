import { useState } from 'react'

const OLD_STORAGE_KEY = 'ctviewer.annotationSaveDir'

// The folder annotations are saved into. It used to be remembered between
// sessions, which meant a folder typed once (or an old dated one) came back on
// its own and annotations went there without the user ever choosing it.
// Now it lives only for the session: the first save asks where to put things,
// and '' means "not chosen yet". Any value an earlier version left behind is
// deleted so it cannot come back.
export function useAnnotationSaveDir(): [string, (next: string) => void] {
  const [dir, setDir] = useState<string>(() => {
    try {
      localStorage.removeItem(OLD_STORAGE_KEY)
    } catch {
      /* storage unavailable — nothing to clean up */
    }
    return ''
  })
  return [dir, setDir]
}
