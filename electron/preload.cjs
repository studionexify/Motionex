// Safe bridge between the renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('nexspiro', {
  platform: process.platform,
  saveFile: (opts) => ipcRenderer.invoke('nx:saveFile', opts),
  openFiles: (opts) => ipcRenderer.invoke('nx:openFiles', opts),
  postProcess: (opts) => ipcRenderer.invoke('nx:postProcess', opts),
  devices: {
    load: () => ipcRenderer.invoke('nx:devices:load'),
    save: (list) => ipcRenderer.invoke('nx:devices:save', list),
    connect: (id, cfg) => ipcRenderer.invoke('nx:dev:connect', id, cfg),
    disconnect: (id) => ipcRenderer.invoke('nx:dev:disconnect', id),
    call: (id, method, args) => ipcRenderer.invoke('nx:dev:call', id, method, args),
    camera: (id, on) => ipcRenderer.invoke('nx:dev:camera', id, on),
    discover: () => ipcRenderer.invoke('nx:dev:discover'),
    onStatus: listen('nx:dev:status'),
    onProgress: listen('nx:dev:progress'),
    onFrame: listen('nx:dev:frame'),
  },
  serial: {
    onPorts: listen('nx:serial:ports'),
    pick: (portId) => ipcRenderer.invoke('nx:serial:pick', portId),
  },
});
