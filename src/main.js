const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const DATA_FILE = path.join(app.getPath('userData'), 'hourglass-data.json');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');

const DEFAULT_STATE = {
  wakeTime: '05:00',
  sleepTime: '23:00',
  hourglasses: [],
  activeId: null,
  lastResetKey: null,
};

let state = { ...DEFAULT_STATE };
let mainWindow = null;
let miniWindow = null;
let saveTimer = null;

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    state = { ...DEFAULT_STATE, ...parsed };
    if (!Array.isArray(state.hourglasses)) state.hourglasses = [];
    // Migrate older data: every hourglass needs a borrowedSeconds field
    // (time reallocated away from it to catch up on schedule).
    for (const hg of state.hourglasses) {
      if (typeof hg.borrowedSeconds !== 'number') hg.borrowedSeconds = 0;
      // Net time moved to/from this hourglass via transfers today
      // (+ received, − given). Resets daily like elapsed/borrowed.
      if (typeof hg.transferredSeconds !== 'number') hg.transferredSeconds = 0;
    }
  } catch {
    state = { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

// Throttled save so we are not hammering the disk every tick.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 2000);
}

// ---------------------------------------------------------------------------
// 5 AM daily reset logic
// ---------------------------------------------------------------------------
// The "hourglass day" begins at 5:00 AM. A reset key is the calendar date of
// the most recent 5 AM boundary. If the current key differs from the stored
// one, every hourglass's elapsed time is wiped back to zero.
function currentResetKey(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 5) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function maybeReset() {
  const key = currentResetKey();
  if (state.lastResetKey !== key) {
    // New day: wipe elapsed time and any reallocated (borrowed) time so the
    // plan starts fresh.
    for (const hg of state.hourglasses) {
      hg.elapsedSeconds = 0;
      hg.borrowedSeconds = 0;
      hg.transferredSeconds = 0;
    }
    state.lastResetKey = key;
    scheduleSave();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Timer tick — runs in the main process so it keeps counting regardless of
// which window is visible.
// ---------------------------------------------------------------------------
function tick() {
  maybeReset();
  if (state.activeId) {
    const hg = state.hourglasses.find((h) => h.id === state.activeId);
    if (hg) {
      hg.elapsedSeconds += 1;
      scheduleSave();
    } else {
      state.activeId = null;
    }
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Broadcasting state to renderer windows
// ---------------------------------------------------------------------------
function broadcastState() {
  const payload = getPublicState();
  for (const win of [mainWindow, miniWindow]) {
    if (win && !win.isDestroyed()) {
      // The frame can be disposed between the check and the send during
      // window teardown, so guard the send itself too.
      try {
        win.webContents.send('state', payload);
      } catch {
        /* window is going away — ignore */
      }
    }
  }
}

function getPublicState() {
  return {
    wakeTime: state.wakeTime,
    sleepTime: state.sleepTime,
    hourglasses: state.hourglasses,
    activeId: state.activeId,
    lastResetKey: state.lastResetKey,
  };
}

// ---------------------------------------------------------------------------
// Hourglass operations
// ---------------------------------------------------------------------------
function makeId() {
  return 'hg_' + Math.random().toString(36).slice(2, 10);
}

// Effective allocation for today = base goal, minus time pulled away to catch
// up (borrowed), plus/minus time moved via transfers.
function effAllocOf(hg) {
  return Math.max(0, hg.allocatedSeconds - (hg.borrowedSeconds || 0) + (hg.transferredSeconds || 0));
}
function remainingOf(hg) {
  return effAllocOf(hg) - hg.elapsedSeconds;
}

// The most time an hourglass can give up to catch-up is whatever it still has
// left (allocation + transfers − time spent) — you can't pull it into overtime.
function clampBorrow(hg, seconds) {
  const ceiling = Math.max(0, hg.allocatedSeconds + (hg.transferredSeconds || 0) - hg.elapsedSeconds);
  return Math.min(Math.max(0, Math.round(seconds || 0)), ceiling);
}

// A key press can reach us twice — once from the global shortcut and once from
// the in-window keydown handler. Collapse duplicate triggers of the same action
// fired within a short window down to one.
let lastAction = { key: '', at: 0 };
function isDuplicate(key) {
  const now = Date.now();
  if (lastAction.key === key && now - lastAction.at < 350) return true;
  lastAction = { key, at: now };
  return false;
}

function setActive(id) {
  if (isDuplicate('active:' + id)) return;
  // Toggle: activating the already-active hourglass pauses everything.
  state.activeId = state.activeId === id ? null : id;
  broadcastState();
  saveState();
}

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  for (const hg of state.hourglasses) {
    if (!hg.keybind) continue;
    try {
      globalShortcut.register(hg.keybind, () => setActive(hg.id));
    } catch (err) {
      console.error(`Failed to register shortcut "${hg.keybind}":`, err);
    }
  }
  // Shift+Esc toggles between the full window and the mini pill. Registered
  // globally so it works even when Hourglass isn't the focused app; the
  // in-window keydown handlers cover the same combo as a fallback.
  try {
    globalShortcut.register('Shift+Escape', toggleView);
  } catch {
    /* couldn't register — in-window handlers still cover it */
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#1a1626',
    title: 'Hourglass',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMiniWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 300;
  const H = 48;
  miniWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 16,
    y: workArea.y + 16,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  miniWindow.setAlwaysOnTop(true, 'screen-saver');
  miniWindow.setVisibleOnAllWorkspaces(true);
  miniWindow.loadFile(path.join(__dirname, 'mini.html'));
}

function collapseToMini() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show();
    broadcastState();
  }
}

function expandToMain() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    broadcastState();
  }
}

// Toggle between the full window and the mini pill.
function toggleView() {
  if (isDuplicate('toggle-view')) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    collapseToMini();
  } else {
    expandToMain();
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('get-state', () => getPublicState());

ipcMain.handle('set-schedule', (_e, { wakeTime, sleepTime }) => {
  if (typeof wakeTime === 'string') state.wakeTime = wakeTime;
  if (typeof sleepTime === 'string') state.sleepTime = sleepTime;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('add-hourglass', (_e, { name, allocatedSeconds, keybind }) => {
  const hg = {
    id: makeId(),
    name: String(name || 'Untitled').trim() || 'Untitled',
    allocatedSeconds: Math.max(0, Math.round(allocatedSeconds || 0)),
    elapsedSeconds: 0,
    borrowedSeconds: 0,
    transferredSeconds: 0,
    keybind: keybind || '',
  };
  state.hourglasses.push(hg);
  registerShortcuts();
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('update-hourglass', (_e, { id, name, allocatedSeconds, keybind }) => {
  const hg = state.hourglasses.find((h) => h.id === id);
  if (hg) {
    if (typeof name === 'string') hg.name = name.trim() || hg.name;
    if (typeof allocatedSeconds === 'number') hg.allocatedSeconds = Math.max(0, Math.round(allocatedSeconds));
    if (typeof keybind === 'string') hg.keybind = keybind;
    // Keep borrowed time within what this hourglass can still give.
    hg.borrowedSeconds = clampBorrow(hg, hg.borrowedSeconds || 0);
    registerShortcuts();
    saveState();
    broadcastState();
  }
  return getPublicState();
});

// Reallocate ("pull") time away from an hourglass to catch up on schedule.
// borrowedSeconds is the total pulled from this hourglass; it can be raised
// (pull more) or lowered (return time) freely, and redirected to another
// hourglass by pulling from that one instead.
ipcMain.handle('set-borrow', (_e, { id, seconds }) => {
  const hg = state.hourglasses.find((h) => h.id === id);
  if (hg) {
    hg.borrowedSeconds = clampBorrow(hg, seconds);
    saveState();
    broadcastState();
  }
  return getPublicState();
});

// Move time from one hourglass to another. The source can only give what it
// still has left; the destination's budget grows by the same amount, so the
// total planned time (and your behind-schedule number) is unchanged.
ipcMain.handle('transfer-time', (_e, { fromId, toId, seconds }) => {
  const from = state.hourglasses.find((h) => h.id === fromId);
  const to = state.hourglasses.find((h) => h.id === toId);
  if (from && to && from !== to) {
    const amount = Math.min(Math.max(0, Math.round(seconds || 0)), Math.max(0, remainingOf(from)));
    if (amount > 0) {
      from.transferredSeconds = (from.transferredSeconds || 0) - amount;
      to.transferredSeconds = (to.transferredSeconds || 0) + amount;
      saveState();
      broadcastState();
    }
  }
  return getPublicState();
});

ipcMain.handle('delete-hourglass', (_e, { id }) => {
  state.hourglasses = state.hourglasses.filter((h) => h.id !== id);
  if (state.activeId === id) state.activeId = null;
  registerShortcuts();
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('set-active', (_e, { id }) => {
  setActive(id);
  return getPublicState();
});

ipcMain.handle('reset-hourglass', (_e, { id }) => {
  const hg = state.hourglasses.find((h) => h.id === id);
  if (hg) hg.elapsedSeconds = 0;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('reset-all', () => {
  for (const hg of state.hourglasses) hg.elapsedSeconds = 0;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('collapse', () => collapseToMini());
ipcMain.handle('expand', () => expandToMain());
ipcMain.handle('toggle-view', () => toggleView());

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// Only ever allow ONE running instance. Global hotkeys (Shift+1, Shift+2, …)
// can be held by just one process system-wide, so a second copy would silently
// fail to register them and the keybinds would appear "dead". If a second copy
// is launched, we surface the existing window instead of starting over.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) expandToMain();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      expandToMain();
    }
  });

  app.whenReady().then(() => {
    loadState();
    maybeReset();
    createMainWindow();
    createMiniWindow();
    registerShortcuts();

    setInterval(tick, 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  saveState();
});

// Keep running in the tray-less background even if the main window closes,
// only fully quit when the user explicitly quits.
app.on('window-all-closed', () => {
  saveState();
  if (process.platform !== 'darwin') app.quit();
});
