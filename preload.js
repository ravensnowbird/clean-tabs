const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  createTab: (data) => ipcRenderer.send('create-tab', data),
  updateTab: (data) => ipcRenderer.send('update-tab', data),
  removeTab: (id) => ipcRenderer.send('remove-tab', id),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),
  openUrl: (data) => ipcRenderer.send('open-url', data),
  setSearchMode: (on) => ipcRenderer.send('set-search-mode', on),
  addCategory: (name) => ipcRenderer.send('add-category', name),
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),
  onTabCreated: (cb) => ipcRenderer.on('tab-created', (e, val) => cb(val)),
  onTabUpdated: (cb) => ipcRenderer.on('tab-updated', (e, val) => cb(val)),
  onTabEdited: (cb) => ipcRenderer.on('tab-edited', (e, val) => cb(val)),
  onActiveTabChanged: (cb) => ipcRenderer.on('active-tab-changed', (e, val) => cb(val)),
  search: (query) => ipcRenderer.invoke('search', query)
});
