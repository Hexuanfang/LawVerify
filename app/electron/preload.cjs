const { contextBridge, ipcRenderer } = require('electron')

const OPEN_EXTERNAL_CHANNEL = 'lawverify:open-external'
const START_APP_UPDATE_CHANNEL = 'lawverify:start-app-update'
const APP_UPDATE_STATUS_CHANNEL = 'lawverify:app-update-status'

contextBridge.exposeInMainWorld('lawVerifyDesktop', {
  platform: process.platform,
  channel: 'electron',
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
