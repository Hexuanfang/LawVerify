const { contextBridge, shell } = require('electron')

contextBridge.exposeInMainWorld('lawVerifyDesktop', {
  platform: process.platform,
  channel: 'electron',
  openExternal: (url) => shell.openExternal(url),
})
