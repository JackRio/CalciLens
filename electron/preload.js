const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  pickPath: (options) => ipcRenderer.invoke('pick-path', options),
})
