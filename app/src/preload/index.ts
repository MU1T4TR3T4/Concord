import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('concord', {
  desktop: true,
  capture: {
    sources: () => ipcRenderer.invoke('capture:sources'),
    choose: (id: string, audio: boolean) => ipcRenderer.invoke('capture:choose', id, audio),
  },
  ptt: {
    configure: (key: unknown) => ipcRenderer.invoke('ptt:configure', key),
    capture: () => ipcRenderer.invoke('ptt:capture'),
    onState: (cb: (down: boolean) => void) => {
      ipcRenderer.on('ptt:state', (_e, down: boolean) => cb(down));
    },
  },
  update: {
    version: () => ipcRenderer.invoke('update:version'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (status: unknown) => void) => {
      ipcRenderer.on('update:status', (_e, status: unknown) => cb(status));
    },
  },
});
