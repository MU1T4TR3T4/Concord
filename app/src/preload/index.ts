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
  invite: {
    pending: () => ipcRenderer.invoke('invite:pending'),
    onInvite: (cb: (url: string) => void) => {
      ipcRenderer.on('invite:open', (_e, url: string) => cb(url));
    },
  },
  control: {
    available: () => ipcRenderer.invoke('control:available'),
    start: (sourceId: string) => ipcRenderer.invoke('control:start', sourceId),
    input: (events: unknown[]) => ipcRenderer.send('control:input', events),
    stop: () => ipcRenderer.invoke('control:stop'),
    onState: (cb: (state: string) => void) => {
      ipcRenderer.on('control:state', (_e, state: string) => cb(state));
    },
    onEnded: (cb: (reason: string) => void) => {
      ipcRenderer.on('control:ended', (_e, reason: string) => cb(reason));
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
