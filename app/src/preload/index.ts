import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('concord', {
  desktop: true,
  capture: {
    sources: () => ipcRenderer.invoke('capture:sources'),
    choose: (id: string, audio: boolean) => ipcRenderer.invoke('capture:choose', id, audio),
  },
});
