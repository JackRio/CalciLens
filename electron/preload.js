const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  pickPath: (options) => ipcRenderer.invoke('pick-path', options),
  savePath: (options) => ipcRenderer.invoke('save-path', options),
  // Closing the window is not immediate: the main process asks the page first,
  // so unsaved annotation edits can be confirmed. The page answers "got it"
  // (closeAck) and then, once it is fine to go, confirmClose.
  onCloseRequested: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('app-close-requested', handler)
    return () => ipcRenderer.removeListener('app-close-requested', handler)
  },
  closeAck: () => ipcRenderer.send('app-close-ack'),
  confirmClose: () => ipcRenderer.send('app-close-confirmed'),
})
