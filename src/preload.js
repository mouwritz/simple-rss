'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the page and the system. The renderer has no Node access.
contextBridge.exposeInMainWorld('api', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),
  fetchFeed: (url) => ipcRenderer.invoke('feed:fetch', url),
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onOpenItem: (callback) => {
    ipcRenderer.on('open-item', (_event, payload) => callback(payload));
  },
});
