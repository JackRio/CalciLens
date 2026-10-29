import type { DragEvent } from 'react'

export interface PickPathOptions {
  properties?: Array<'openFile' | 'openDirectory'>
  filters?: { name: string; extensions: string[] }[]
}

declare global {
  interface Window {
    electronAPI?: {
      pickPath: (options?: PickPathOptions) => Promise<string | null>
      savePath: (options?: { defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      pathForFile: (file: File) => string
      onCloseRequested: (callback: () => void) => () => void
      closeAck: () => void
      confirmClose: () => void
    }
  }
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

export async function pickPath(options?: PickPathOptions): Promise<string | null> {
  if (!window.electronAPI) return null
  return window.electronAPI.pickPath(options)
}

// The on-disk path of a file or folder dropped onto the page ("" outside
// Electron, where a browser never reveals it).
export function droppedPath(e: DragEvent): string {
  const file = e.dataTransfer.files[0]
  if (!file || !window.electronAPI) return ''
  return window.electronAPI.pathForFile(file)
}

// Dialog filters match a single trailing extension, so ".nii.gz" is filtered
// as "gz" (there's no way to filter on the compound extension specifically).
export const IMAGE_FILE_FILTERS = [
  { name: 'Medical images', extensions: ['nii', 'gz', 'mha', 'mhd'] },
  { name: 'All files', extensions: ['*'] },
]
