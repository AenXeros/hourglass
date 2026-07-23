const api = window.hourglass;

let state = { wakeTime: '05:00', sleepTime: '23:00', hourglasses: [], activeId: null };
let editingId = null;
let reallocOpen = false;
// Transfer modal working state: { fromId, toId, seconds } while open, else null.
let transfer = null;

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

// Effective allocation = the base goal, minus time pulled away to catch up
// (borrowed), plus/minus time moved via transfers with other hourglasses.
function effAlloc(h) {
  return Math.max(0, h.allocatedSeconds - (h.borrowedSeconds || 0) + (h.transferredSeconds || 0));
}

// How far behind schedule, in seconds (may be negative when on schedule).
// = work still left across all hourglasses − time left before bed. Pulling
// time from a task lowers its effective allocation, which lowers work-left,
// which directly reduces this number.
function behindSeconds() {
  const workLeft = state.hourglasses.reduce(
    (sum, h) => sum + Math.max(0, effAlloc(h) - h.elapsedSeconds), 0);
  return workLeft - secondsUntilSleep();
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
  // "Your Day" totals reflect the base plan, not reallocated budgets — pulling
  // time from a task to catch up doesn't turn it into free/unallocated time.
  const allocated = state.hourglasses.reduce((sum, h) => sum + h.allocatedSeconds, 0);
  document.getElementById('hoursAwake').textContent = fmtHours(awake) + ' h';
  document.getElementById('hoursAllocated').textContent = fmtHours(allocated) + ' h';
  const free = awake - allocated;
  const freeEl = document.getElementById('hoursFree');
  freeEl.textContent = fmtHours(free) + ' h';
  freeEl.classList.toggle('negative', free < 0);

  // Behind-schedule banner ---------------------------------------------------
  const statusEl = document.getElementById('scheduleStatus');
  const valueEl = document.getElementById('ssValue');
  const catchUpBtn = document.getElementById('catchUpBtn');
  const totalBorrowed = state.hourglasses.reduce((s, h) => s + (h.borrowedSeconds || 0), 0);
  if (!state.hourglasses.length) {
    statusEl.style.display = 'none';
  } else {
    const behind = behindSeconds();
    const behindMin = Math.round(behind / 60);
    statusEl.style.display = 'flex';
    if (behindMin >= 1) {
      statusEl.className = 'schedule-status behind';
      valueEl.textContent = `${fmtMins(behind)} behind schedule`;
      catchUpBtn.style.display = '';
      catchUpBtn.textContent = 'Catch up';
    } else {
      statusEl.className = 'schedule-status ontrack';
      valueEl.textContent = '✓ On schedule';
      // Still offer a way back in to return/redirect any reallocated time.
      catchUpBtn.style.display = totalBorrowed > 0 ? '' : 'none';
      catchUpBtn.textContent = 'Adjust';
    }
  }
  if (reallocOpen) renderReallocModal();
  if (transfer) renderTransferModal();

  // List
  const list = document.getElementById('hourglassList');
  const empty = document.getElementById('emptyState');
  list.innerHTML = '';
  empty.style.display = state.hourglasses.length ? 'none' : 'block';

  for (const hg of state.hourglasses) {
    const alloc = effAlloc(hg);
    const remaining = alloc - hg.elapsedSeconds;
    const isActive = state.activeId === hg.id;
    const over = remaining < 0;
    const borrowed = hg.borrowedSeconds || 0;
    const transferred = hg.transferredSeconds || 0;
    const pct = alloc > 0
      ? Math.min(100, (hg.elapsedSeconds / alloc) * 100)
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
        <div class="hg-sub">${fmtDuration(hg.elapsedSeconds)} spent · ${fmtHours(alloc)} h goal${borrowed > 0 ? ` · <span class="hg-borrowed">−${fmtMins(borrowed)} reallocated</span>` : ''}${transferred > 0 ? ` · <span class="hg-received">+${fmtMins(transferred)} received</span>` : ''}${transferred < 0 ? ` · <span class="hg-given">−${fmtMins(-transferred)} given</span>` : ''}</div>
      </div>
      <div class="hg-actions">
        <button class="toggle-btn ${isActive ? 'on' : ''}" data-act="toggle" data-id="${hg.id}">
          ${isActive ? '● Running' : 'Start'}
        </button>
        <button class="mini-icon" data-act="transfer" data-id="${hg.id}" title="Transfer time to another hourglass">⇄</button>
        <button class="mini-icon" data-act="edit" data-id="${hg.id}" title="Edit">✎</button>
        <button class="mini-icon" data-act="reset" data-id="${hg.id}" title="Reset this timer">↺</button>
        <button class="mini-icon danger" data-act="delete" data-id="${hg.id}" title="Delete">✕</button>
      </div>
    `;
    list.appendChild(card);
  }

  renderColdCall();
}

// ---------------------------------------------------------------------------
// Cold call reminder
// ---------------------------------------------------------------------------
// How many calls you'd make in a day if you hit every reminder.
// The first reminder lands one interval after the active period opens, and
// none fires at the closing moment, so a W-minute window at an I-minute
// cadence yields ceil(W / I) − 1 reminders.
function coldCallGoal() {
  const cc = state.coldCall || {};
  if (!cc.enabled) return null;
  const interval = Math.max(1, cc.intervalMinutes || 30);
  const perReminder = Math.max(1, cc.callsPerReminder || 1);

  let windowMinutes;
  if (cc.windowEnabled) {
    const toMin = (s) => {
      const [h, m] = String(s || '0:0').split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const s = toMin(cc.windowStart);
    const e = toMin(cc.windowEnd);
    windowMinutes = s === e ? 1440 : (e - s + 1440) % 1440;
  } else {
    // No window set — fall back to your waking hours.
    windowMinutes = hoursAwake() / 60;
  }

  const reminders = Math.max(0, Math.ceil(windowMinutes / interval) - 1);
  return reminders * perReminder;
}

function renderColdCall() {
  const cc = state.coldCall || {};
  const card = document.getElementById('coldCallCard');
  const enabledEl = document.getElementById('ccEnabled');
  const intervalEl = document.getElementById('ccInterval');
  const callsEl = document.getElementById('ccCalls');

  // Don't clobber a field the user is currently editing.
  const winEl = document.getElementById('ccWindowEnabled');
  const winStartEl = document.getElementById('ccWindowStart');
  const winEndEl = document.getElementById('ccWindowEnd');

  if (document.activeElement !== enabledEl) enabledEl.checked = !!cc.enabled;
  if (document.activeElement !== intervalEl) intervalEl.value = cc.intervalMinutes || 30;
  if (document.activeElement !== callsEl) callsEl.value = cc.callsPerReminder || 5;
  if (document.activeElement !== winEl) winEl.checked = !!cc.windowEnabled;
  if (document.activeElement !== winStartEl) winStartEl.value = cc.windowStart || '14:00';
  if (document.activeElement !== winEndEl) winEndEl.value = cc.windowEnd || '20:00';

  const nextEl = document.getElementById('ccNext');
  if (!cc.enabled) {
    nextEl.textContent = 'Off';
  } else if (!cc.nextDueAt) {
    // Main pauses the cycle (nextDueAt = null) outside the active hours.
    nextEl.textContent = cc.windowEnabled ? 'Outside hours' : '—';
  } else {
    nextEl.textContent = fmtDuration(Math.max(0, Math.ceil((cc.nextDueAt - Date.now()) / 1000)));
  }

  const done = cc.doneToday || 0;
  const goal = coldCallGoal();
  const todayEl = document.getElementById('ccToday');
  todayEl.textContent = done;
  todayEl.classList.toggle('met', goal !== null && goal > 0 && done >= goal);
  document.getElementById('ccGoal').textContent = goal === null ? '—' : goal;

  const due = !!cc.awaitingLog;
  card.classList.toggle('due', due);
  const dueEl = document.getElementById('ccDue');
  dueEl.style.display = due ? '' : 'none';
  if (due) {
    const n = cc.callsPerReminder || 1;
    dueEl.textContent = `Time to make ${n} cold call${n === 1 ? '' : 's'} — how many did you do?`;
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

// Cold call reminder controls
async function pushColdCallConfig() {
  state = await api.setColdCall({
    enabled: document.getElementById('ccEnabled').checked,
    intervalMinutes: parseInt(document.getElementById('ccInterval').value, 10) || 30,
    callsPerReminder: parseInt(document.getElementById('ccCalls').value, 10) || 5,
    windowEnabled: document.getElementById('ccWindowEnabled').checked,
    windowStart: document.getElementById('ccWindowStart').value || '14:00',
    windowEnd: document.getElementById('ccWindowEnd').value || '20:00',
  });
  render();
}
for (const id of ['ccEnabled', 'ccInterval', 'ccCalls', 'ccWindowEnabled', 'ccWindowStart', 'ccWindowEnd']) {
  document.getElementById(id).addEventListener('change', pushColdCallConfig);
}

document.querySelector('.cc-log').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cc]');
  if (!btn) return;
  state = await api.logColdCalls(parseInt(btn.dataset.cc, 10) || 0);
  render();
});
document.getElementById('ccCustomAdd').addEventListener('click', async () => {
  const el = document.getElementById('ccCustom');
  const n = parseInt(el.value, 10);
  if (!n || n <= 0) return;
  state = await api.logColdCalls(n);
  el.value = '';
  render();
});
document.getElementById('ccResetToday').addEventListener('click', async () => {
  state = await api.resetColdCalls();
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
  } else if (act === 'transfer') {
    openTransfer(id);
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
// Reallocate ("catch up") modal
// ---------------------------------------------------------------------------
const reallocModal = document.getElementById('reallocModal');
const STEP = 300; // 5 minutes

function openRealloc() {
  reallocOpen = true;
  reallocModal.classList.remove('hidden');
  renderReallocModal();
}
function closeRealloc() {
  reallocOpen = false;
  reallocModal.classList.add('hidden');
}

function renderReallocModal() {
  const statusEl = document.getElementById('reallocStatus');
  const listEl = document.getElementById('reallocList');
  const deficit = Math.max(0, behindSeconds());

  if (Math.round(deficit / 60) >= 1) {
    statusEl.className = 'realloc-status behind';
    statusEl.textContent = `${fmtMins(deficit)} to make up`;
  } else {
    statusEl.className = 'realloc-status ontrack';
    statusEl.textContent = '✓ On schedule';
  }

  listEl.innerHTML = '';
  for (const hg of state.hourglasses) {
    const ceiling = Math.max(0, hg.allocatedSeconds + (hg.transferredSeconds || 0) - hg.elapsedSeconds); // max pullable
    const borrowed = hg.borrowedSeconds || 0;
    const spareLeft = Math.max(0, ceiling - borrowed); // task time still remaining
    const canPullMore = spareLeft > 0;

    const row = document.createElement('div');
    row.className = 'realloc-row';
    row.innerHTML = `
      <div class="rr-top">
        <span class="rr-name">${escapeHtml(hg.name)}</span>
        <span class="rr-spare">${fmtMins(spareLeft)} left${borrowed > 0 ? ` <span class="rr-pulled">· −${fmtMins(borrowed)} pulled</span>` : ''}</span>
      </div>
      <div class="rr-controls">
        <div class="rr-stepper">
          <button class="rr-btn" data-ract="minus" data-id="${hg.id}" ${borrowed <= 0 ? 'disabled' : ''}>−5m</button>
          <span class="rr-amount">${fmtMins(borrowed)}</span>
          <button class="rr-btn" data-ract="plus" data-id="${hg.id}" ${!canPullMore ? 'disabled' : ''}>+5m</button>
        </div>
        <div class="rr-actions">
          ${borrowed > 0 ? `<button class="rr-btn ghost" data-ract="return" data-id="${hg.id}">Return</button>` : ''}
          ${deficit > 0 && canPullMore ? `<button class="rr-btn cover" data-ract="fill" data-id="${hg.id}">Cover</button>` : ''}
        </div>
      </div>
    `;
    listEl.appendChild(row);
  }
}

document.getElementById('catchUpBtn').addEventListener('click', openRealloc);
document.getElementById('reallocDone').addEventListener('click', closeRealloc);
reallocModal.addEventListener('click', (e) => {
  if (e.target === reallocModal) closeRealloc();
});

document.getElementById('reallocList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ract]');
  if (!btn) return;
  const id = btn.dataset.id;
  const hg = state.hourglasses.find((h) => h.id === id);
  if (!hg) return;
  const ceiling = Math.max(0, hg.allocatedSeconds + (hg.transferredSeconds || 0) - hg.elapsedSeconds);
  const borrowed = hg.borrowedSeconds || 0;
  let target = borrowed;
  switch (btn.dataset.ract) {
    case 'minus': target = borrowed - STEP; break;
    case 'plus': target = borrowed + STEP; break;
    case 'return': target = 0; break;
    case 'fill': target = Math.min(ceiling, borrowed + Math.max(0, behindSeconds())); break;
  }
  target = Math.max(0, Math.min(ceiling, target));
  state = await api.setBorrow(id, target);
  render();
});

// ---------------------------------------------------------------------------
// Transfer time modal
// ---------------------------------------------------------------------------
const transferModal = document.getElementById('transferModal');

function openTransfer(id) {
  transfer = { fromId: id, toId: null, seconds: 0 };
  transferModal.classList.remove('hidden');
  renderTransferModal();
}
function closeTransfer() {
  transfer = null;
  transferModal.classList.add('hidden');
}

function availToTransfer(hg) {
  return Math.max(0, effAlloc(hg) - hg.elapsedSeconds);
}

function renderTransferModal() {
  if (!transfer) return;
  const from = state.hourglasses.find((h) => h.id === transfer.fromId);
  if (!from) { closeTransfer(); return; }
  const avail = availToTransfer(from);
  transfer.seconds = Math.max(0, Math.min(transfer.seconds, avail));

  document.getElementById('transferFrom').innerHTML =
    `From <strong>${escapeHtml(from.name)}</strong> · <span class="tr-avail">${fmtMins(avail)} available</span>`;
  document.getElementById('transferAmount').textContent = fmtMins(transfer.seconds);

  const destEl = document.getElementById('transferDest');
  destEl.innerHTML = '';
  const others = state.hourglasses.filter((h) => h.id !== transfer.fromId);
  if (!others.length) {
    destEl.innerHTML = '<div class="tr-empty">No other hourglasses to send to.</div>';
  }
  for (const h of others) {
    const rem = availToTransfer(h);
    const btn = document.createElement('button');
    btn.className = 'tr-dest' + (transfer.toId === h.id ? ' selected' : '');
    btn.dataset.dest = h.id;
    btn.innerHTML = `<span class="tr-dest-name">${escapeHtml(h.name)}</span><span class="tr-dest-rem">${fmtMins(rem)} left</span>`;
    destEl.appendChild(btn);
  }

  document.getElementById('trMinus').disabled = transfer.seconds <= 0;
  document.getElementById('trPlus').disabled = transfer.seconds >= avail;
  document.getElementById('trMax').disabled = avail <= 0;
  document.getElementById('transferConfirm').disabled = !(transfer.seconds > 0 && transfer.toId);
}

document.getElementById('trMinus').addEventListener('click', () => {
  if (transfer) { transfer.seconds -= STEP; renderTransferModal(); }
});
document.getElementById('trPlus').addEventListener('click', () => {
  if (transfer) { transfer.seconds += STEP; renderTransferModal(); }
});
document.getElementById('trMax').addEventListener('click', () => {
  const from = transfer && state.hourglasses.find((h) => h.id === transfer.fromId);
  if (from) { transfer.seconds = availToTransfer(from); renderTransferModal(); }
});
document.getElementById('transferDest').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dest]');
  if (btn && transfer) { transfer.toId = btn.dataset.dest; renderTransferModal(); }
});
document.getElementById('transferCancel').addEventListener('click', closeTransfer);
document.getElementById('transferConfirm').addEventListener('click', async () => {
  if (!transfer || !transfer.toId || transfer.seconds <= 0) return;
  state = await api.transferTime(transfer.fromId, transfer.toId, transfer.seconds);
  closeTransfer();
  render();
});
transferModal.addEventListener('click', (e) => {
  if (e.target === transferModal) closeTransfer();
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
