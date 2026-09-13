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

app.whenReady().then(() => {
  startPythonServer()
  waitForServerReady(createWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function killPython() {
  if (pyProc) {
    pyProc.kill()
    pyProc = null
  }
}

app.on('window-all-closed', () => {
  killPython()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killPython)
