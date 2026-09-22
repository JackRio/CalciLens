const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

const PORT = 8000
const SERVER_URL = `http://127.0.0.1:${PORT}`

let pyProc = null
let mainWindow = null

function resolvePython() {
  const isPackaged = app.isPackaged
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  const winPython = path.join(base, '.venv', 'Scripts', 'python.exe')
  const nixPython = path.join(base, '.venv', 'bin', 'python')
  if (fs.existsSync(winPython)) return winPython
  if (fs.existsSync(nixPython)) return nixPython
  // Fall back to whatever "python" is on PATH (dev machines without a venv yet)
  return process.platform === 'win32' ? 'python' : 'python3'
}

function resolveServerDir() {
  const isPackaged = app.isPackaged
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  return path.join(base, 'server')
}

// Is something already serving on our port? If so it is almost certainly a
// second copy of this app, and attaching to it is dangerous: both windows
// would share one volume cache, and whichever window closes first kills the
// backend out from under the other, taking any unsaved annotation with it.
function probePort(callback) {
  const req = http.get(`${SERVER_URL}/api/defaults`, (res) => {
    res.resume()
    callback(true)
  })
  req.on('error', () => callback(false))
  req.setTimeout(1500, () => {
    req.destroy()
    callback(false)
  })
}

function startPythonServer() {
  const pythonExe = resolvePython()
  const serverDir = resolveServerDir()
  pyProc = spawn(pythonExe, ['-m', 'uvicorn', 'app:app', '--port', String(PORT)], {
    cwd: serverDir,
  })
  pyProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
  pyProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  pyProc.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`)
    // If the backend dies while the app is still up, every request from here
    // on fails and any unsaved annotation is already gone. Say so plainly
    // rather than leaving the window looking functional.
    if (code !== 0 && code !== null && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Backend stopped',
        'The CT Viewer backend process exited unexpectedly. Any unsaved annotation changes have been lost. ' +
          'Please restart the application.',
      )
    }
  })
}

function waitForServerReady(callback, attemptsLeft = 100) {
  const req = http.get(`${SERVER_URL}/api/defaults`, (res) => {
    res.resume()
    callback()
  })
  req.on('error', () => {
    if (attemptsLeft <= 0) {
      console.error('Backend server did not start in time.')
      callback()
      return
    }
    setTimeout(() => waitForServerReady(callback, attemptsLeft - 1), 300)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'CT Viewer',
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14151a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  Menu.setApplicationMenu(null)
  mainWindow.loadURL(SERVER_URL)
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

ipcMain.handle('pick-path', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: options.properties || ['openFile'],
    filters: options.filters || [],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// One instance only. Without this lock, launching the app twice left the
// second copy's uvicorn unable to bind the port while its window silently
// attached to the FIRST copy's backend — two windows sharing one volume
// cache, and closing either one killing the server for both.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    probePort((inUse) => {
      if (inUse) {
        // Something else already answers on this port. Attaching to it would
        // mean operating on a backend this process does not control.
        dialog.showErrorBox(
          'Port already in use',
          `Something is already serving on port ${PORT}. If another copy of CT Viewer is running, use that window. ` +
            'Otherwise stop whatever is using the port and start the app again.',
        )
        app.quit()
        return
      }
      startPythonServer()
      waitForServerReady(createWindow)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

function killPython() {
  if (pyProc) {
    pyProc.kill()
    pyProc = null
  }
}

// Annotation, manifest and sidecar writes are all atomic (temp file +
// os.replace), so a kill here can no longer leave a half-written file — the
// previous version is simply kept. The grace period below is belt and
// braces for an in-flight request, not the thing that makes saving safe.
function shutdown() {
  killPython()
}

app.on('window-all-closed', () => {
  shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', shutdown)
