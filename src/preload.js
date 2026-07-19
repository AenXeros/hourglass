const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hourglass', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSchedule: (wakeTime, sleepTime) => ipcRenderer.invoke('set-schedule', { wakeTime, sleepTime }),
  addHourglass: (name, allocatedSeconds, keybind) =>
    ipcRenderer.invoke('add-hourglass', { name, allocatedSeconds, keybind }),
  updateHourglass: (id, fields) => ipcRenderer.invoke('update-hourglass', { id, ...fields }),
  deleteHourglass: (id) => ipcRenderer.invoke('delete-hourglass', { id }),
  setActive: (id) => ipcRenderer.invoke('set-active', { id }),
  resetHourglass: (id) => ipcRenderer.invoke('reset-hourglass', { id }),
  resetAll: () => ipcRenderer.invoke('reset-all'),
  collapse: () => ipcRenderer.invoke('collapse'),
  expand: () => ipcRenderer.invoke('expand'),
  toggleView: () => ipcRenderer.invoke('toggle-view'),
  onState: (cb) => {
    ipcRenderer.on('state', (_e, payload) => cb(payload));
  },
});
