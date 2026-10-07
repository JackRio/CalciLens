export interface PickPathOptions {
  properties?: Array<'openFile' | 'openDirectory'>
  filters?: { name: string; extensions: string[] }[]
}

declare global {
  interface Window {
    electronAPI?: {
      pickPath: (options?: PickPathOptions) => Promise<string | null>
      savePath: (options?: { defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
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

// Dialog filters match a single trailing extension, so ".nii.gz" is filtered
// as "gz" (there's no way to filter on the compound extension specifically).
export const IMAGE_FILE_FILTERS = [
  { name: 'Medical images', extensions: ['nii', 'gz', 'mha', 'mhd'] },
  { name: 'All files', extensions: ['*'] },
]
