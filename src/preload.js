const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hourglass', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSchedule: (wakeTime, sleepTime) => ipcRenderer.invoke('set-schedule', { wakeTime, sleepTime }),
  addHourglass: (name, allocatedSeconds, keybind) =>
    ipcRenderer.invoke('add-hourglass', { name, allocatedSeconds, keybind }),
  updateHourglass: (id, fields) => ipcRenderer.invoke('update-hourglass', { id, ...fields }),
  deleteHourglass: (id) => ipcRenderer.invoke('delete-hourglass', { id }),
  setActive: (id) => ipcRenderer.invoke('set-active', { id }),
  setBorrow: (id, seconds) => ipcRenderer.invoke('set-borrow', { id, seconds }),
  transferTime: (fromId, toId, seconds) => ipcRenderer.invoke('transfer-time', { fromId, toId, seconds }),
  resetHourglass: (id) => ipcRenderer.invoke('reset-hourglass', { id }),
  resetAll: () => ipcRenderer.invoke('reset-all'),
  setColdCall: (cfg) => ipcRenderer.invoke('set-cold-call', cfg),
  logColdCalls: (count) => ipcRenderer.invoke('log-cold-calls', { count }),
  resetColdCalls: () => ipcRenderer.invoke('reset-cold-calls'),
  setAutoSwitch: (cfg) => ipcRenderer.invoke('set-auto-switch', cfg),
  collapse: () => ipcRenderer.invoke('collapse'),
  expand: () => ipcRenderer.invoke('expand'),
  toggleView: () => ipcRenderer.invoke('toggle-view'),
  onState: (cb) => {
    ipcRenderer.on('state', (_e, payload) => cb(payload));
  },
});
