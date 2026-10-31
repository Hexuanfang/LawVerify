const { contextBridge, ipcRenderer } = require('electron')

const OPEN_EXTERNAL_CHANNEL = 'lawverify:open-external'
const START_APP_UPDATE_CHANNEL = 'lawverify:start-app-update'
const APP_UPDATE_STATUS_CHANNEL = 'lawverify:app-update-status'
const ACCOUNT_REQUEST_CHANNEL = 'lawverify:account-request'

contextBridge.exposeInMainWorld('lawVerifyDesktop', {
  platform: process.platform,
  arch: process.arch,
  channel: 'electron',
  requestAccount: (payload) => ipcRenderer.invoke(ACCOUNT_REQUEST_CHANNEL, payload),
  reportDiagnostic: (payload) => ipcRenderer.send('lawverify:renderer-diagnostic', payload),
  getServiceStatus: () => ipcRenderer.invoke('lawverify:get-service-status'),
  onServiceStatus: (listener) => {
    if (typeof listener !== 'function') return () => {}
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('lawverify:service-status', handler)
    return () => ipcRenderer.removeListener('lawverify:service-status', handler)
  },
  linkCaseDirectory: (payload) => ipcRenderer.invoke('lawverify:case-directories-link', payload),
  onCaseDirectoryBatch: (listener) => {
    if (typeof listener !== 'function') return () => {}
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('lawverify:case-directories-batch', handler)
    return () => ipcRenderer.removeListener('lawverify:case-directories-batch', handler)
  },
  scanCaseDirectories: (payload) => ipcRenderer.invoke('lawverify:case-directories-scan', payload),
  clearCaseDirectories: (payload) => ipcRenderer.invoke('lawverify:case-directories-clear', payload),
  readCaseDirectoryFile: (payload) => ipcRenderer.invoke('lawverify:case-directories-read', payload),
  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  startAppUpdate: (payload) => ipcRenderer.invoke(START_APP_UPDATE_CHANNEL, payload),
  onAppUpdateStatus: (listener) => {
    if (typeof listener !== 'function') {
      return () => {}
    }

    const handleStatus = (_event, payload) => {
      listener(payload)
    }

    ipcRenderer.on(APP_UPDATE_STATUS_CHANNEL, handleStatus)
    return () => {
      ipcRenderer.removeListener(APP_UPDATE_STATUS_CHANNEL, handleStatus)
    }
  },
})
