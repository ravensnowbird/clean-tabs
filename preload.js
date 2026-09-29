// Electron preload script for the indexer renderer (index.html).
//
// This bridge exposes exactly the channels that index.html uses. It was
// reconstructed to include the two new channels required by the footer / log
// features:
//   - api.openExternal(url)          -> shell.openExternal in the main process
//   - api.onIndexResult(callback)    -> receives unpersistant per-session index events
// and the existing getInitialState() now also returns `indexSelectors`.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Tabs
  createTab: (data) => ipcRenderer.send('create-tab', data),
  updateTab: (data) => ipcRenderer.send('update-tab', data),
  removeTab: (id) => ipcRenderer.send('remove-tab', id),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),

  // Categories
  addCategory: (name) => ipcRenderer.send('add-category', name),

  // Search area
  setSearchMode: (on) => ipcRenderer.send('set-search-mode', on),

  // Overlay control: hide/show the active browser view while an overlay is open
  setViewHidden: (reason, hidden) => ipcRenderer.send('set-view-hidden', { reason, hidden }),
  openUrl: (data) => ipcRenderer.send('open-url', data),
  search: (query) => ipcRenderer.invoke('search', query),

  // Initial persisted state (also returns `indexSelectors`)
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),

  // Outbound events from main -> renderer
  onTabCreated: (cb) => {
    ipcRenderer.on('tab-created', (event, data) => cb(data));
  },
  onTabUpdated: (cb) => {
    ipcRenderer.on('tab-updated', (event, data) => cb(data));
  },
  onTabEdited: (cb) => {
    ipcRenderer.on('tab-edited', (event, data) => cb(data));
  },
  onActiveTabChanged: (cb) => {
    ipcRenderer.on('active-tab-changed', (event, tabId) => cb(tabId));
  },

  // Footer links: open URLs in the system default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Unpersistant per-session index event stream (used by the Index Log report)
  onIndexResult: (cb) => {
    ipcRenderer.on('index-result', (event, data) => cb(data));
  },

  importTabsFromUrl: (url) => ipcRenderer.invoke('import-tabs-from-url', url),
});
