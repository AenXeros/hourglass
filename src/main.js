const { app, BrowserWindow, ipcMain, globalShortcut, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const DATA_FILE = path.join(app.getPath('userData'), 'hourglass-data.json');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');
const EXT_PATH = path.join(__dirname, '..', 'browser-extension');

const DEFAULT_COLD_CALL = {
  enabled: false,
  intervalMinutes: 30,   // remind me every X minutes
  callsPerReminder: 5,   // ...to make X cold calls
  nextDueAt: null,       // epoch ms of the next reminder
  doneToday: 0,          // total calls logged since the 5 AM reset
  remindersToday: 0,
  awaitingLog: false,    // a reminder fired and hasn't been logged yet
  windowEnabled: false,  // only remind during set hours?
  windowStart: '14:00',
  windowEnd: '20:00',
};

const DEFAULT_STATE = {
  wakeTime: '05:00',
  sleepTime: '23:00',
  hourglasses: [],
  activeId: null,
  lastResetKey: null,
  coldCall: { ...DEFAULT_COLD_CALL },
  // Per-day history: { 'YYYY-MM-DD': [ { id, name, seconds }, ... ] }
  history: {},
  // Stopwatches: a separate count-UP system with its own keybinds & records.
  stopwatches: [],
  activeStopwatchId: null,
  stopwatchHistory: {},
  // Which system the GLOBAL keybinds control: 'hourglass' | 'stopwatch'.
  mode: 'hourglass',
  autoSwitch: {
    enabled: false,
    entertainmentId: '', // hourglass for YouTube / Instagram ('' = auto by name)
    quranId: '',         // hourglass for quran.com
    learnId: '',         // hourglass for the excluded channel ('' = auto: Physics)
    excludeChannel: 'Doner', // matches his name "Chris Doner" AND handle @donerphysics
  },
};

const HISTORY_MAX_DAYS = 120;
const AUTO_PORT = 45871; // localhost port the browser extension talks to

// Live, non-persisted browser-connection status.
let autoStatus = { connected: false, lastSeenAt: 0, site: '', channel: '', targetName: '' };
let autoActivatedId = null; // the hourglass auto-switch turned on (so we know what to auto-pause)
let lastContextKey = null; // identity of the last-seen tab context (to detect real arrivals vs heartbeats)
let autoServer = null;

let state = { ...DEFAULT_STATE };
let mainWindow = null;
let miniWindow = null;
let saveTimer = null;

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    // Tolerate a UTF-8 BOM, which some editors/tools prepend.
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
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
    state.coldCall = { ...DEFAULT_COLD_CALL, ...(parsed.coldCall || {}) };
    state.history =
      parsed.history && typeof parsed.history === 'object' && !Array.isArray(parsed.history)
        ? parsed.history
        : {};
    state.autoSwitch = { ...DEFAULT_STATE.autoSwitch, ...(parsed.autoSwitch || {}) };
    // Stopwatch system
    if (!Array.isArray(state.stopwatches)) state.stopwatches = [];
    for (const sw of state.stopwatches) {
      if (typeof sw.elapsedSeconds !== 'number') sw.elapsedSeconds = 0;
    }
    state.stopwatchHistory =
      parsed.stopwatchHistory && typeof parsed.stopwatchHistory === 'object' && !Array.isArray(parsed.stopwatchHistory)
        ? parsed.stopwatchHistory
        : {};
    state.mode = parsed.mode === 'stopwatch' ? 'stopwatch' : 'hourglass';
  } catch (err) {
    // The file exists but couldn't be read/parsed. Preserve a copy BEFORE we
    // start saving defaults over it — otherwise one corrupt file silently
    // destroys the user's entire setup.
    try {
      if (fs.existsSync(DATA_FILE)) {
        const backup = `${DATA_FILE.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`;
        fs.copyFileSync(DATA_FILE, backup);
        console.error(`Unreadable data file; original preserved at ${backup}`, err);
      }
    } catch (copyErr) {
      console.error('Could not preserve unreadable data file:', copyErr);
    }
    state = { ...DEFAULT_STATE };
    state.coldCall = { ...DEFAULT_COLD_CALL };
    state.history = {};
    state.autoSwitch = { ...DEFAULT_STATE.autoSwitch };
    state.stopwatches = [];
    state.stopwatchHistory = {};
    state.mode = 'hourglass';
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
    // Archive the finishing day's time-per-task before wiping it.
    if (state.lastResetKey) {
      const entries = state.hourglasses
        .filter((hg) => hg.elapsedSeconds > 0)
        .map((hg) => ({ id: hg.id, name: hg.name, seconds: hg.elapsedSeconds }));
      if (entries.length) {
        if (!state.history) state.history = {};
        state.history[state.lastResetKey] = entries;
      }
      // Keep history bounded.
      const keys = Object.keys(state.history).sort();
      while (keys.length > HISTORY_MAX_DAYS) delete state.history[keys.shift()];

      // Archive stopwatches into their own separate history.
      const swEntries = state.stopwatches
        .filter((sw) => sw.elapsedSeconds > 0)
        .map((sw) => ({ id: sw.id, name: sw.name, seconds: sw.elapsedSeconds }));
      if (swEntries.length) {
        if (!state.stopwatchHistory) state.stopwatchHistory = {};
        state.stopwatchHistory[state.lastResetKey] = swEntries;
      }
      const swKeys = Object.keys(state.stopwatchHistory || {}).sort();
      while (swKeys.length > HISTORY_MAX_DAYS) delete state.stopwatchHistory[swKeys.shift()];
    }
    // New day: wipe stopwatch elapsed too (they keep running from zero).
    for (const sw of state.stopwatches) sw.elapsedSeconds = 0;
    // New day: wipe elapsed time and any reallocated (borrowed) time so the
    // plan starts fresh.
    for (const hg of state.hourglasses) {
      hg.elapsedSeconds = 0;
      hg.borrowedSeconds = 0;
      hg.transferredSeconds = 0;
    }
    // Cold-call tally starts fresh each day too.
    const cc = state.coldCall;
    if (cc) {
      cc.doneToday = 0;
      cc.remindersToday = 0;
      cc.awaitingLog = false;
      // checkColdCall reschedules on the next tick, respecting active hours.
      cc.nextDueAt = null;
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
// ---------------------------------------------------------------------------
// Cold-call reminders
// ---------------------------------------------------------------------------
function notifyColdCall(count) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Cold call time',
      body: `Time to make ${count} cold call${count === 1 ? '' : 's'}.`,
      icon: ICON_PATH,
    });
    n.on('click', () => expandToMain());
    n.show();
  } catch (err) {
    console.error('Cold-call notification failed:', err);
  }
}

// Is `now` inside the HH:MM..HH:MM window? Handles windows that cross
// midnight (e.g. 20:00 → 02:00). The closing minute is INCLUSIVE, so a
// reminder landing exactly on the closing time still fires.
function withinWindow(now, start, end) {
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return true; // identical times = always active
  return s < e ? cur >= s && cur <= e : cur >= s || cur <= e;
}

function checkColdCall() {
  const cc = state.coldCall;
  if (!cc || !cc.enabled) return;
  const now = Date.now();

  // Outside the active hours: hold the cycle entirely. Any already-fired
  // reminder stays loggable, we just stop scheduling new ones.
  if (cc.windowEnabled && !withinWindow(new Date(now), cc.windowStart, cc.windowEnd)) {
    if (cc.nextDueAt !== null) {
      cc.nextDueAt = null;
      scheduleSave();
    }
    return;
  }

  // Inside the window (or no window): make sure the countdown is running.
  if (!cc.nextDueAt) {
    cc.nextDueAt = now + Math.max(1, cc.intervalMinutes) * 60000;
    scheduleSave();
    return;
  }

  if (now >= cc.nextDueAt) {
    cc.awaitingLog = true;
    cc.remindersToday += 1;
    // Schedule the next one from now, so reminders keep coming on cadence
    // even if this one goes unlogged.
    cc.nextDueAt = now + Math.max(1, cc.intervalMinutes) * 60000;
    notifyColdCall(cc.callsPerReminder);
    scheduleSave();
  }
}

// ---------------------------------------------------------------------------
// Website auto-switch (driven by the companion browser extension)
// ---------------------------------------------------------------------------
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resolve which hourglass a role maps to: an explicitly chosen id if it still
// exists, otherwise a best-effort match by name.
function resolveRole(role) {
  const cfg = state.autoSwitch;
  const exists = (id) => id && state.hourglasses.some((h) => h.id === id);
  const byName = (re) => {
    const h = state.hourglasses.find((x) => re.test(x.name));
    return h ? h.id : null;
  };
  if (role === 'ent') return exists(cfg.entertainmentId) ? cfg.entertainmentId : byName(/entertain|youtube|instagram/i);
  if (role === 'quran') return exists(cfg.quranId) ? cfg.quranId : byName(/quran|prayer/i);
  // The excluded "learning" channel defaults to the Physics timer.
  if (role === 'learn') return exists(cfg.learnId) ? cfg.learnId : byName(/physics/i);
  return null;
}

function isExcludedChannel(ctx) {
  const token = normName(state.autoSwitch.excludeChannel);
  if (!token) return false;
  const yt = ctx.youtube || {};
  const name = normName(yt.channelName);
  const handle = normName(yt.channelHandle);
  return (name && name.includes(token)) || (handle && handle.includes(token));
}

// Which hourglass id should be running for this browser context (or null).
function contextTarget(ctx) {
  switch (ctx.site) {
    case 'quran': return resolveRole('quran');
    case 'instagram': return resolveRole('ent');
    case 'youtube': return isExcludedChannel(ctx) ? resolveRole('learn') : resolveRole('ent');
    default: return null;
  }
}

// A stable identity for "what tab/content you're currently on", so we can tell
// a real arrival (you moved to different content) from the periodic heartbeat
// for the tab you're already sitting on. Keyed by channel for YouTube (ignores
// per-video URL churn), else by site.
function contextKey(ctx) {
  if (ctx.site === 'youtube') {
    const yt = ctx.youtube || {};
    return 'youtube|' + (yt.channelId || yt.channelHandle || yt.channelName || '');
  }
  return ctx.site || 'other';
}

function nameOf(id) {
  const h = state.hourglasses.find((x) => x.id === id);
  return h ? h.name : '';
}

function handleContext(ctx) {
  autoStatus.connected = true;
  autoStatus.lastSeenAt = Date.now();
  autoStatus.site = ctx.site || 'other';
  autoStatus.channel = (ctx.youtube && ctx.youtube.channelName) || '';

  const key = contextKey(ctx);
  const isArrival = key !== lastContextKey;
  lastContextKey = key;

  if (state.autoSwitch.enabled && state.mode === 'hourglass') {
    const target = contextTarget(ctx);
    // Switch ONLY when you ARRIVE on a mapped site (the tab's content changed
    // since the last report) — never on the periodic heartbeat for the tab you
    // are already sitting on. So if you turn a timer off by hand while staying
    // put, it stays off; it only comes back when you leave and return. On an
    // unmapped tab, leave whatever is running (the timer holds).
    if (isArrival && target && state.activeId !== target) {
      state.activeId = target;
      autoActivatedId = target;
      scheduleSave();
    }
    autoStatus.targetName = target ? nameOf(target) : '';
  } else {
    autoStatus.targetName = '';
  }
  broadcastState();
}

function startAutoServer() {
  autoServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/ping') {
      autoStatus.connected = true;
      autoStatus.lastSeenAt = Date.now();
      res.writeHead(200); res.end('ok');
      return;
    }
    if (req.url === '/context' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let ctx = {};
        try { ctx = JSON.parse(body || '{}'); } catch { /* ignore */ }
        handleContext(ctx);
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  autoServer.on('error', (err) => console.error('Auto-switch server error:', err));
  autoServer.listen(AUTO_PORT, '127.0.0.1');
}

function tick() {
  maybeReset();
  checkColdCall();
  // Drop the "connected" badge if the extension has gone quiet.
  if (autoStatus.connected && Date.now() - autoStatus.lastSeenAt > 90000) {
    autoStatus.connected = false;
  }
  if (state.activeId) {
    const hg = state.hourglasses.find((h) => h.id === state.activeId);
    if (hg) {
      hg.elapsedSeconds += 1;
      scheduleSave();
    } else {
      state.activeId = null;
    }
  } else if (state.activeStopwatchId) {
    const sw = state.stopwatches.find((s) => s.id === state.activeStopwatchId);
    if (sw) {
      sw.elapsedSeconds += 1;
      scheduleSave();
    } else {
      state.activeStopwatchId = null;
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
    coldCall: state.coldCall,
    history: state.history,
    autoSwitch: state.autoSwitch,
    autoStatus,
    extensionPath: EXT_PATH,
    stopwatches: state.stopwatches,
    activeStopwatchId: state.activeStopwatchId,
    stopwatchHistory: state.stopwatchHistory,
    mode: state.mode,
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
  if (state.activeId) state.activeStopwatchId = null; // only one timer runs app-wide
  broadcastState();
  saveState();
}

function setActiveStopwatch(id) {
  if (isDuplicate('sw:' + id)) return;
  state.activeStopwatchId = state.activeStopwatchId === id ? null : id;
  if (state.activeStopwatchId) state.activeId = null; // pause any hourglass
  broadcastState();
  saveState();
}

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  // Only the active mode's keybinds are live, so hourglass and stopwatch
  // shortcuts can safely overlap.
  if (state.mode === 'stopwatch') {
    for (const sw of state.stopwatches) {
      if (!sw.keybind) continue;
      try {
        globalShortcut.register(sw.keybind, () => setActiveStopwatch(sw.id));
      } catch (err) {
        console.error(`Failed to register stopwatch shortcut "${sw.keybind}":`, err);
      }
    }
  } else {
    for (const hg of state.hourglasses) {
      if (!hg.keybind) continue;
      try {
        globalShortcut.register(hg.keybind, () => setActive(hg.id));
      } catch (err) {
        console.error(`Failed to register shortcut "${hg.keybind}":`, err);
      }
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

// --- Cold-call reminders ---------------------------------------------------
ipcMain.handle('set-cold-call', (_e, cfg = {}) => {
  const cc = state.coldCall;
  const wasEnabled = cc.enabled;
  const oldInterval = cc.intervalMinutes;
  if (typeof cfg.enabled === 'boolean') cc.enabled = cfg.enabled;
  if (typeof cfg.intervalMinutes === 'number') {
    cc.intervalMinutes = Math.min(600, Math.max(1, Math.round(cfg.intervalMinutes)));
  }
  if (typeof cfg.callsPerReminder === 'number') {
    cc.callsPerReminder = Math.min(999, Math.max(1, Math.round(cfg.callsPerReminder)));
  }
  const oldWindow = `${cc.windowEnabled}|${cc.windowStart}|${cc.windowEnd}`;
  if (typeof cfg.windowEnabled === 'boolean') cc.windowEnabled = cfg.windowEnabled;
  if (typeof cfg.windowStart === 'string') cc.windowStart = cfg.windowStart;
  if (typeof cfg.windowEnd === 'string') cc.windowEnd = cfg.windowEnd;
  const windowChanged = oldWindow !== `${cc.windowEnabled}|${cc.windowStart}|${cc.windowEnd}`;

  if (cc.enabled) {
    // Restart the countdown when switching on, or changing interval/hours.
    if (!wasEnabled || cc.intervalMinutes !== oldInterval || windowChanged) {
      cc.nextDueAt = null;
    }
    checkColdCall(); // reschedule now, honouring the active-hours window
  } else {
    cc.nextDueAt = null;
    cc.awaitingLog = false;
  }
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('log-cold-calls', (_e, { count }) => {
  const cc = state.coldCall;
  cc.doneToday = Math.max(0, (cc.doneToday || 0) + Math.max(0, Math.round(count || 0)));
  cc.awaitingLog = false;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('reset-cold-calls', () => {
  state.coldCall.doneToday = 0;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('set-auto-switch', (_e, cfg = {}) => {
  const a = state.autoSwitch;
  if (typeof cfg.enabled === 'boolean') a.enabled = cfg.enabled;
  if (typeof cfg.entertainmentId === 'string') a.entertainmentId = cfg.entertainmentId;
  if (typeof cfg.quranId === 'string') a.quranId = cfg.quranId;
  if (typeof cfg.learnId === 'string') a.learnId = cfg.learnId;
  if (typeof cfg.excludeChannel === 'string') a.excludeChannel = cfg.excludeChannel;
  if (!a.enabled) autoActivatedId = null;
  lastContextKey = null; // re-arm so a settings change applies to the current tab
  saveState();
  broadcastState();
  return getPublicState();
});

// --- Stopwatches ------------------------------------------------------------
ipcMain.handle('set-mode', (_e, { mode }) => {
  state.mode = mode === 'stopwatch' ? 'stopwatch' : 'hourglass';
  registerShortcuts(); // swap which keybinds are live
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('add-stopwatch', (_e, { name, keybind }) => {
  state.stopwatches.push({
    id: makeId(),
    name: String(name || 'Untitled').trim() || 'Untitled',
    elapsedSeconds: 0,
    keybind: keybind || '',
  });
  registerShortcuts();
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('update-stopwatch', (_e, { id, name, keybind }) => {
  const sw = state.stopwatches.find((s) => s.id === id);
  if (sw) {
    if (typeof name === 'string') sw.name = name.trim() || sw.name;
    if (typeof keybind === 'string') sw.keybind = keybind;
    registerShortcuts();
    saveState();
    broadcastState();
  }
  return getPublicState();
});

ipcMain.handle('delete-stopwatch', (_e, { id }) => {
  state.stopwatches = state.stopwatches.filter((s) => s.id !== id);
  if (state.activeStopwatchId === id) state.activeStopwatchId = null;
  registerShortcuts();
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('set-active-stopwatch', (_e, { id }) => {
  setActiveStopwatch(id);
  return getPublicState();
});

ipcMain.handle('reset-stopwatch', (_e, { id }) => {
  const sw = state.stopwatches.find((s) => s.id === id);
  if (sw) sw.elapsedSeconds = 0;
  saveState();
  broadcastState();
  return getPublicState();
});

ipcMain.handle('reset-all-stopwatches', () => {
  for (const sw of state.stopwatches) sw.elapsedSeconds = 0;
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
    // Required for Windows toast notifications to show the app identity.
    if (process.platform === 'win32') app.setAppUserModelId('com.hourglass.app');
    loadState();
    maybeReset();
    createMainWindow();
    createMiniWindow();
    registerShortcuts();
    startAutoServer();

    setInterval(tick, 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (autoServer) { try { autoServer.close(); } catch { /* ignore */ } }
  saveState();
});

// Keep running in the tray-less background even if the main window closes,
// only fully quit when the user explicitly quits.
app.on('window-all-closed', () => {
  saveState();
  if (process.platform !== 'darwin') app.quit();
});
