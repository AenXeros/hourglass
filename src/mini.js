const api = window.hourglass;

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

function render(state) {
  const mini = document.getElementById('mini');
  const active = state.hourglasses.find((h) => h.id === state.activeId);

  if (!active) {
    mini.classList.remove('active', 'over');
    document.getElementById('miniName').textContent = 'No task running';
    document.getElementById('miniTime').textContent = '—:—';
    document.getElementById('miniBar').style.width = '0%';
    return;
  }

  const remaining = active.allocatedSeconds - active.elapsedSeconds;
  const over = remaining < 0;
  // Fill represents time LEFT — it drains from full toward empty like sand.
  const pct = active.allocatedSeconds > 0
    ? Math.max(0, Math.min(100, (remaining / active.allocatedSeconds) * 100))
    : 0;

  mini.classList.add('active');
  mini.classList.toggle('over', over);
  document.getElementById('miniName').textContent = active.name;
  document.getElementById('miniTime').textContent = fmtDuration(remaining);
  document.getElementById('miniBar').style.width = pct + '%';
}

document.getElementById('expandBtn').addEventListener('click', () => api.expand());

// Shift+Esc expands the pill back into the full window.
document.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'Escape') {
    e.preventDefault();
    api.toggleView();
  }
});

api.onState(render);

(async () => {
  render(await api.getState());
})();
