const api = window.hourglass;

let state = { wakeTime: '05:00', sleepTime: '23:00', hourglasses: [], activeId: null };
let editingId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDuration(totalSec) {
  const neg = totalSec < 0;
  let s = Math.abs(Math.round(totalSec));
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const core =
    h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  return (neg ? '-' : '') + core;
}

function fmtHours(sec) {
  const h = sec / 3600;
  return (Math.round(h * 10) / 10).toString();
}

function timeToMinutes(t) {
  const [h, m] = (t || '0:0').split(':').map(Number);
  return h * 60 + m;
}

function hoursAwake() {
  const wake = timeToMinutes(state.wakeTime);
  const sleep = timeToMinutes(state.sleepTime);
  let diff = (sleep - wake + 1440) % 1440;
  if (diff === 0) diff = 1440;
  return diff * 60; // seconds
}

// Seconds from right now until the next occurrence of the sleep time.
function secondsUntilSleep() {
  const now = new Date();
  const [sh, sm] = (state.sleepTime || '0:0').split(':').map(Number);
  const sleep = new Date(now);
  sleep.setHours(sh, sm, 0, 0);
  if (sleep <= now) sleep.setDate(sleep.getDate() + 1);
  return Math.floor((sleep - now) / 1000);
}

// Whole-minute duration label, e.g. "1h 05m" or "32m".
function fmtMins(sec) {
  const total = Math.round(Math.abs(sec) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Keybind capture
// ---------------------------------------------------------------------------
function normalizeKey(e) {
  const code = e.code;
  let m;
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return `F${m[1]}`;
  const map = {
    Space: 'Space',
    Escape: 'Escape',
    Enter: 'Enter',
    Tab: 'Tab',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Backslash: '\\',
  };
  return map[code] || null;
}

function eventToAccelerator(e) {
  const key = normalizeKey(e);
  if (!key) return null; // pure modifier press
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

// Wires an input so clicking it and pressing keys records an accelerator.
// The captured value is stored on input.dataset.accel.
function makeKeybindInput(input) {
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.code === 'Backspace' || e.code === 'Delete') {
      input.value = '';
      input.dataset.accel = '';
      return;
    }
    const accel = eventToAccelerator(e);
    if (accel) {
      input.value = accel;
      input.dataset.accel = accel;
      input.blur();
    }
  });
  input.addEventListener('focus', () => {
    input.value = 'Press keys…';
  });
  input.addEventListener('blur', () => {
    input.value = input.dataset.accel || '';
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  // Schedule fields (don't clobber while user is editing them)
  const wakeEl = document.getElementById('wakeTime');
  const sleepEl = document.getElementById('sleepTime');
  if (document.activeElement !== wakeEl) wakeEl.value = state.wakeTime;
  if (document.activeElement !== sleepEl) sleepEl.value = state.sleepTime;

  const awake = hoursAwake();
  const allocated = state.hourglasses.reduce((sum, h) => sum + h.allocatedSeconds, 0);
  document.getElementById('hoursAwake').textContent = fmtHours(awake) + ' h';
  document.getElementById('hoursAllocated').textContent = fmtHours(allocated) + ' h';
  const free = awake - allocated;
  const freeEl = document.getElementById('hoursFree');
  freeEl.textContent = fmtHours(free) + ' h';
  freeEl.classList.toggle('negative', free < 0);

  // Behind-schedule banner ---------------------------------------------------
  // "Behind" = lost time you have to make up, counted as a debt:
  //   idle time (no hourglass running) + overtime (time spent past a task's
  //   allocation). Computed as: work still left − time left before bed + any
  //   unallocated slack, so both idle AND overtime always add to it regardless
  //   of buffer. Never goes below zero.
  const statusEl = document.getElementById('scheduleStatus');
  if (!state.hourglasses.length) {
    statusEl.style.display = 'none';
  } else {
    const workLeft = state.hourglasses.reduce(
      (sum, h) => sum + Math.max(0, h.allocatedSeconds - h.elapsedSeconds), 0);
    const slack = awake - allocated; // unallocated free time in the day
    const behind = Math.max(0, workLeft - secondsUntilSleep() + slack);
    const behindMin = Math.round(behind / 60);
    const valueEl = document.getElementById('ssValue');

    statusEl.style.display = 'flex';
    if (behindMin >= 1) {
      statusEl.className = 'schedule-status behind';
      valueEl.textContent = `${fmtMins(behind)} behind schedule`;
    } else {
      statusEl.className = 'schedule-status ontrack';
      valueEl.textContent = 'On track';
    }
  }

  // List
  const list = document.getElementById('hourglassList');
  const empty = document.getElementById('emptyState');
  list.innerHTML = '';
  empty.style.display = state.hourglasses.length ? 'none' : 'block';

  for (const hg of state.hourglasses) {
    const remaining = hg.allocatedSeconds - hg.elapsedSeconds;
    const isActive = state.activeId === hg.id;
    const over = remaining < 0;
    const pct = hg.allocatedSeconds > 0
      ? Math.min(100, (hg.elapsedSeconds / hg.allocatedSeconds) * 100)
      : 0;

    const card = document.createElement('div');
    card.className = 'hg-card' + (isActive ? ' active' : '') + (over ? ' over' : '');

    card.innerHTML = `
      <div class="hg-main">
        <div class="hg-head">
          <span class="hg-name">${escapeHtml(hg.name)}</span>
          ${hg.keybind ? `<span class="hg-keybind">${escapeHtml(hg.keybind)}</span>` : ''}
        </div>
        <div class="hg-time ${over ? 'over' : ''}">${fmtDuration(remaining)} ${over ? '<span class="over-tag">over</span>' : 'left'}</div>
        <div class="hg-bar"><div class="hg-bar-fill" style="width:${pct}%"></div></div>
        <div class="hg-sub">${fmtDuration(hg.elapsedSeconds)} spent · ${fmtHours(hg.allocatedSeconds)} h goal</div>
      </div>
      <div class="hg-actions">
        <button class="toggle-btn ${isActive ? 'on' : ''}" data-act="toggle" data-id="${hg.id}">
          ${isActive ? '● Running' : 'Start'}
        </button>
        <button class="mini-icon" data-act="edit" data-id="${hg.id}" title="Edit">✎</button>
        <button class="mini-icon" data-act="reset" data-id="${hg.id}" title="Reset this timer">↺</button>
        <button class="mini-icon danger" data-act="delete" data-id="${hg.id}" title="Delete">✕</button>
      </div>
    `;
    list.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
document.getElementById('collapseBtn').addEventListener('click', () => api.collapse());

// Shift+Esc shrinks the full window into the mini pill.
document.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'Escape') {
    // Don't fire while the user is recording a keybind.
    if (e.target && e.target.classList && e.target.classList.contains('keybind-input')) return;
    e.preventDefault();
    api.toggleView();
  }
});
document.getElementById('resetAllBtn').addEventListener('click', async () => {
  state = await api.resetAll();
  render();
});

document.getElementById('wakeTime').addEventListener('change', async (e) => {
  state = await api.setSchedule(e.target.value, state.sleepTime);
  render();
});
document.getElementById('sleepTime').addEventListener('change', async (e) => {
  state = await api.setSchedule(state.wakeTime, e.target.value);
  render();
});

// Add form
makeKeybindInput(document.getElementById('hgKeybind'));
document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('hgName').value.trim();
  if (!name) return;
  const hours = parseInt(document.getElementById('hgHours').value, 10) || 0;
  const mins = parseInt(document.getElementById('hgMinutes').value, 10) || 0;
  const seconds = hours * 3600 + mins * 60;
  const keybind = document.getElementById('hgKeybind').dataset.accel || '';
  state = await api.addHourglass(name, seconds, keybind);
  // reset the form
  document.getElementById('hgName').value = '';
  document.getElementById('hgHours').value = '1';
  document.getElementById('hgMinutes').value = '0';
  const kb = document.getElementById('hgKeybind');
  kb.value = '';
  kb.dataset.accel = '';
  render();
});

// List actions (event delegation)
document.getElementById('hourglassList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'toggle') {
    state = await api.setActive(id);
  } else if (act === 'reset') {
    state = await api.resetHourglass(id);
  } else if (act === 'delete') {
    const hg = state.hourglasses.find((h) => h.id === id);
    if (confirm(`Delete "${hg ? hg.name : 'this hourglass'}"?`)) {
      state = await api.deleteHourglass(id);
    }
  } else if (act === 'edit') {
    openEdit(id);
  }
  render();
});

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------
const modal = document.getElementById('editModal');
makeKeybindInput(document.getElementById('editKeybind'));

function openEdit(id) {
  const hg = state.hourglasses.find((h) => h.id === id);
  if (!hg) return;
  editingId = id;
  document.getElementById('editName').value = hg.name;
  document.getElementById('editHours').value = Math.floor(hg.allocatedSeconds / 3600);
  document.getElementById('editMinutes').value = Math.floor((hg.allocatedSeconds % 3600) / 60);
  const kb = document.getElementById('editKeybind');
  kb.value = hg.keybind || '';
  kb.dataset.accel = hg.keybind || '';
  modal.classList.remove('hidden');
}

document.getElementById('editCancel').addEventListener('click', () => {
  modal.classList.add('hidden');
  editingId = null;
});
document.getElementById('clearKeybind').addEventListener('click', () => {
  const kb = document.getElementById('editKeybind');
  kb.value = '';
  kb.dataset.accel = '';
});
document.getElementById('editSave').addEventListener('click', async () => {
  if (!editingId) return;
  const name = document.getElementById('editName').value.trim();
  const hours = parseInt(document.getElementById('editHours').value, 10) || 0;
  const mins = parseInt(document.getElementById('editMinutes').value, 10) || 0;
  state = await api.updateHourglass(editingId, {
    name,
    allocatedSeconds: hours * 3600 + mins * 60,
    keybind: document.getElementById('editKeybind').dataset.accel || '',
  });
  modal.classList.add('hidden');
  editingId = null;
  render();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    modal.classList.add('hidden');
    editingId = null;
  }
});

// ---------------------------------------------------------------------------
// Live updates from main process
// ---------------------------------------------------------------------------
api.onState((s) => {
  state = s;
  render();
});

(async () => {
  state = await api.getState();
  render();
})();
