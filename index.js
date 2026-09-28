const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

let mainWindow;
let db;
let activeTabId = null;
const tabs = new Map(); // tabId -> { ...metadata, view }  (view is null until activated)
// new
const pendingIndex = new Map(); // view -> debounce timer

const INDEX_SELECTORS = {
  // Example: for chatgpt.com, only index the side-pane host element.
  // Adjust the selector to whatever you confirm in DevTools.
  'chatgpt.com': ['.group\\/side-pane-shell-host'],

  // Example: a specific tab id that should index only certain containers:
  // 'tab-1727000000000': ['#main-content', '#sidebar']
};



// Initialize SQLite with Full-Text Search (FTS5) + persistence tables
function initDatabase() {
  db = new Database(path.join(app.getPath('userData'), 'indexer.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      tab_id TEXT,
      title TEXT,
      content TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(tab_id UNINDEXED, url, title, content);

    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      position INTEGER
    );

    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      url TEXT,
      custom_name TEXT,
      default_name TEXT,
      category TEXT,
      extractor TEXT,
      favicon TEXT,
      position INTEGER
    );
  `);

  // Migrate older index schemas (index was previously keyed by tab id, not url)
  const pageCols = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
  if (!pageCols.includes('tab_id')) {
    db.exec('DROP TABLE IF EXISTS pages');
    db.exec('DROP TABLE IF EXISTS pages_fts');
    db.exec('CREATE TABLE pages (url TEXT PRIMARY KEY, tab_id TEXT, title TEXT, content TEXT)');
    db.exec('CREATE VIRTUAL TABLE pages_fts USING fts5(tab_id UNINDEXED, url, title, content)');
  }

  // Ensure the default category always exists
  db.prepare('INSERT OR IGNORE INTO categories (name, position) VALUES (?, ?)').run('Uncategorized', 0);
}

// Load persisted tab metadata into memory (views are created lazily on activation)
function loadPersistedTabs() {
  const rows = db.prepare('SELECT * FROM tabs ORDER BY position ASC').all();
  for (const row of rows) {
    tabs.set(row.id, {
      id: row.id,
      url: row.url,
      customName: row.custom_name,
      defaultName: row.default_name,
      category: row.category || 'Uncategorized',
      favicon: row.favicon || '',
      isActive: false,
      extractor: row.extractor || null,
      view: null
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  // Adjust child views when main window resizes
  mainWindow.on('resize', () => {
    const activeTab = Array.from(tabs.values()).find(t => t.isActive);
    if (activeTab && activeTab.view) updateViewBounds(activeTab.view);
  });
}

function updateViewBounds(view) {
  const [width, height] = mainWindow.getContentSize();
  const sidebarWidth = 260; // Matches CSS sidebar width
  view.setBounds({ x: sidebarWidth, y: 0, width: width - sidebarWidth, height });
}


// Resolve selector(s) for this navigation: explicit tab id wins, else hostname, else none.
function getIndexSelectors(tabId, url) {
  if (Object.prototype.hasOwnProperty.call(INDEX_SELECTORS, tabId)) {
    return INDEX_SELECTORS[tabId];
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return INDEX_SELECTORS[hostname];
  } catch {
    return null;
  }
}

// Build a JS snippet that gathers innerText/textContent from all matches.
// function buildSelectorScript(selectors) {
//   const list = Array.isArray(selectors) ? selectors : [selectors];
//   const parts = list.map((sel) =>
//     `Array.from(document.querySelectorAll(${JSON.stringify(sel)}))` +
//     `.map(function(e){return typeof e.innerText==='string'?e.innerText:(e.textContent||'')})` +
//     `.join('\\n')`
//   );
//   // If multiple selectors, join them with a blank line between groups
//   return parts.join(" + '\\n\\n' + ");
// }


function buildSelectorScript(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const selLiterals = list.map(s => JSON.stringify(s)).join(', ');
  return `(function(){
  var out = [];
  var sels = [${selLiterals}];
  for (var i = 0; i < sels.length; i++) {
    try {
      var els = Array.from(document.querySelectorAll(sels[i]));
      if (!els.length) { console.warn('[indexer] matched 0 elements for', sels[i]); continue; }
      out = out.concat(els.map(function(e){
        return typeof e.innerText === 'string' ? e.innerText : (e.textContent || '');
      }));
    } catch (err) {
      console.error('[indexer] selector failed:', sels[i], '->', err && err.message ? err.message : err);
    }
  }
  return out.join('\\n\\n');
})()`;
}

// Index the currently loaded page of a tab (keyed by URL so history is preserved)
// function indexPage(tabId, view) {
//   try {
//     const url = view.webContents.getURL();
//     if (!url || url === 'about:blank') return;
//     const title = view.webContents.getTitle();
//     view.webContents.executeJavaScript('document.body.innerText').then(text => {
//       console.log("innertext", text);
//       db.prepare('INSERT OR REPLACE INTO pages (url, tab_id, title, content) VALUES (?, ?, ?, ?)')
//         .run(url, tabId, title, text);
//       db.prepare('DELETE FROM pages_fts WHERE url = ?').run(url);
//       db.prepare('INSERT INTO pages_fts (tab_id, url, title, content) VALUES (?, ?, ?, ?)')
//         .run(tabId, url, title, text);
//     }).catch(err => console.error('Indexing failed:', err));
//   } catch (err) {
//     console.error('Indexing failed:', err);
//   }
// }
// Index the currently loaded page of a tab (keyed by URL so history is preserved)
function indexPage(tabId, view, navigatedUrl) {
  console.log("starting-index")
  try {
    const url = navigatedUrl || view.webContents.getURL();
    if (!url || url === 'about:blank') return;

    const tab = tabs.get(tabId);
    const raw = tab?.extractor;
    let js = 'document.body.innerText';
    if (raw && raw.trim()) {
      const selectors = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (selectors.length) js = buildSelectorScript(selectors);
    }
    const title = view.webContents.getTitle();
    // view.webContents.executeJavaScript('document.body.innerText').then(text => {
    view.webContents.executeJavaScript(js).then(text => {
    // Guard: if the view navigated away while extraction was running, skip the stale write.
      if (view.webContents.getURL() !== url) return;
      console.log(text)
      db.prepare('INSERT OR REPLACE INTO pages (url, tab_id, title, content) VALUES (?, ?, ?, ?)')
        .run(url, tabId, title, text);
      db.prepare('DELETE FROM pages_fts WHERE url = ?').run(url);
      db.prepare('INSERT INTO pages_fts (tab_id, url, title, content) VALUES (?, ?, ?, ?)')
        .run(tabId, url, title, text);
    }).catch(err => console.error('Indexing failed:', err));
  } catch (err) {
    console.error('Indexing failed:', err);
  }
}

// Debounce rapid/SPA navigations so we index the final rendered content, not the in-between state
function scheduleIndex(tabId, view, url) {
  if (pendingIndex.has(view)) clearTimeout(pendingIndex.get(view));
  pendingIndex.set(
    view,
    setTimeout(() => {
      pendingIndex.delete(view);
      if (typeof view.isDestroyed === 'function' && view.isDestroyed()) return;
      indexPage(tabId, view, url);
    }, 1000),

    setTimeout(() => {
      pendingIndex.delete(view);
      if (typeof view.isDestroyed === 'function' && view.isDestroyed()) return;
      indexPage(tabId, view, url);
    }, 2000),

    setTimeout(() => {
      pendingIndex.delete(view);
      if (typeof view.isDestroyed === 'function' && view.isDestroyed()) return;
      indexPage(tabId, view, url);
    }, 3000),

    setTimeout(() => {
      pendingIndex.delete(view);
      if (typeof view.isDestroyed === 'function' && view.isDestroyed()) return;
      indexPage(tabId, view, url);
    }, 4000),
  );
}

// Lazily build the WebContentsView for a tab (used on create and on first activation)
function createTabView(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || tab.view) return tab ? tab.view : null;

  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'page-preload.js') }
  });
  tab.view = view;
  view.webContents.loadURL(tab.url);

  // Handle favicon updates
  view.webContents.on('page-favicon-updated', (e, favicons) => {
    if (favicons.length > 0) {
      tab.favicon = favicons[0];
      db.prepare('UPDATE tabs SET favicon = ? WHERE id = ?').run(favicons[0], tabId);
      mainWindow.webContents.send('tab-updated', { id: tabId, favicon: favicons[0] });
    }
  });

  // Handle title updates
  view.webContents.on('page-title-updated', (e, title) => {
    if (!tab.customName) {
      tab.defaultName = title;
      db.prepare('UPDATE tabs SET default_name = ? WHERE id = ?').run(title, tabId);
      mainWindow.webContents.send('tab-updated', { id: tabId, title });
    }
  });

  // Re-index on every completed navigation (i.e. every URL clicked within the tab)
  view.webContents.on('did-stop-loading', (event, url) => {
    scheduleIndex(tabId, view, url);
  });

  return view;
}

// Register IPC Listeners
ipcMain.on('create-tab', (event, { url, name, category, extractor  }) => {
  const tabId = `tab-${Date.now()}`;
  let initialUrl = url.startsWith('http') ? url : `https://${url}`;

  let defaultDomain = '';
  try {
    defaultDomain = new URL(initialUrl).hostname;
  } catch {
    defaultDomain = initialUrl;
  }

  const tabData = {
    id: tabId,
    url: initialUrl,
    customName: name ? name.trim() : null,
    defaultName: defaultDomain,
    category: category || 'Uncategorized',
    favicon: '',
    isActive: false,
    extractor: extractor || null
  };

  // Persist the tab
  const position = db.prepare('SELECT COUNT(*) AS c FROM tabs').get().c;
  db.prepare(`
      INSERT INTO tabs (id, url, custom_name, default_name, category, favicon, position, extractor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tabId,
      initialUrl,
      tabData.customName,
      tabData.defaultName,
      tabData.category,
      '',
      position,
      tabData.extractor
    );

  tabs.set(tabId, { ...tabData, view: null });
  createTabView(tabId);

  // Notify UI of new tab
  mainWindow.webContents.send('tab-created', tabData);
  switchTab(tabId);
});

// Edit an existing tab (name, category and/or url)
ipcMain.on('update-tab', (event, { id, url, name, category, extractor }) => {
  const tab = tabs.get(id);
  if (!tab) return;

  let newUrl = tab.url;
  if (url && url.trim()) {
    newUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
  }
  const urlChanged = newUrl !== tab.url;

  tab.url = newUrl;
  tab.customName = name && name.trim() ? name.trim() : null;
  tab.category = category || 'Uncategorized';
  tab.extractor = extractor !== undefined ? (extractor || null) : tab.extractor; // NEW

  if (urlChanged) {
    try {
      tab.defaultName = new URL(newUrl).hostname;
    } catch {
      tab.defaultName = newUrl;
    }
  }

  db.prepare(
    'UPDATE tabs SET url = ?, custom_name = ?, default_name = ?, category = ?, extractor = ? WHERE id = ?'
  ).run(newUrl, tab.customName, tab.defaultName, tab.category, tab.extractor, id);

  if (urlChanged && tab.view) tab.view.webContents.loadURL(newUrl);

  mainWindow.webContents.send('tab-edited', {
    id,
    url: newUrl,
    customName: tab.customName,
    defaultName: tab.defaultName,
    category: tab.category,
    extractor: tab.extractor
  });
});

// Remove a tab entirely
ipcMain.on('remove-tab', (event, id) => {
  const tab = tabs.get(id);
  if (!tab) return;

  if (tab.view) {
    try {
      mainWindow.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch (err) {
      console.error('Failed to close tab view:', err);
    }
  }

  tabs.delete(id);
  if (activeTabId === id) activeTabId = null;

  db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
  db.prepare('DELETE FROM pages WHERE tab_id = ?').run(id);
  db.prepare('DELETE FROM pages_fts WHERE tab_id = ?').run(id);
});

// Persist a new category
ipcMain.on('add-category', (event, name) => {
  const clean = (name || '').trim();
  if (!clean) return;
  const position = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  db.prepare('INSERT OR IGNORE INTO categories (name, position) VALUES (?, ?)').run(clean, position);
});

// Provide saved categories + tabs to the renderer on startup
ipcMain.handle('get-initial-state', () => {
  const categories = db.prepare('SELECT name FROM categories ORDER BY position ASC').all().map(r => r.name);
  const tabList = Array.from(tabs.values()).map(t => ({
    id: t.id,
    url: t.url,
    customName: t.customName,
    defaultName: t.defaultName,
    category: t.category,
    favicon: t.favicon,
    extractor: t.extractor
  }));
  return { categories, tabs: tabList };
});

// Toggle the "search area" by detaching / reattaching the active browser view
ipcMain.on('set-search-mode', (event, on) => {
  const tab = tabs.get(activeTabId);
  if (!tab || !tab.view) return;
  if (on) {
    mainWindow.contentView.removeChildView(tab.view);
  } else {
    mainWindow.contentView.addChildView(tab.view);
    updateViewBounds(tab.view);
  }
});

// Open a search result: activate the appropriate tab and navigate it to the URL
ipcMain.on('open-url', (event, { tabId, url }) => {
  let id = tabId && tabs.has(tabId) ? tabId : activeTabId;
  if (!id || !tabs.has(id)) return;

  createTabView(id);
  const tab = tabs.get(id);
  if (url) tab.view.webContents.loadURL(url);
  switchTab(id);
});

ipcMain.on('switch-tab', (event, tabId) => switchTab(tabId));

function switchTab(tabId) {
  createTabView(tabId); // build the view on first activation if needed
  activeTabId = tabId;

  tabs.forEach((tab, id) => {
    if (id === tabId) {
      tab.isActive = true;
      if (tab.view) {
        mainWindow.contentView.addChildView(tab.view);
        updateViewBounds(tab.view);
      }
    } else {
      tab.isActive = false;
      if (tab.view) mainWindow.contentView.removeChildView(tab.view);
    }
  });
  mainWindow.webContents.send('active-tab-changed', tabId);
}

function buildFtsQuery(userInput) {
  const trimmed = userInput.trim();
  if (!trimmed) return '';

  // Remove FTS special characters to avoid syntax errors
  const sanitized = trimmed
    .replace(/["'`():\-+*^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) return '';

  // Phrase search with trailing wildcard (matches "hello wor" → "hello world")
  return `"${sanitized}"*`;
}

// Search Handler
ipcMain.handle('search', (event, query) => {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    const stmt = db.prepare(`
      SELECT tab_id, url, title, snippet(pages_fts, 3, '<b>', '</b>', '...', 12) as snippet
      FROM pages_fts
      WHERE pages_fts MATCH ?
      LIMIT 20
    `);
    return stmt.all(ftsQuery);
  } catch {
    // Ignore FTS syntax errors from partial/in-progress queries
    return [];
  }
});

app.whenReady().then(() => {
  initDatabase();
  loadPersistedTabs();
  createWindow();
});
