// Confere se o gancho global de teclado (apertar para falar) carrega e liga dentro do Electron.
const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const { uIOhook } = require('uiohook-napi');
    uIOhook.on('keydown', () => {});
    uIOhook.start();
    console.log('HOOK ok: carregou e ligou');
    setTimeout(() => { uIOhook.stop(); console.log('HOOK desligado'); app.quit(); }, 800);
  } catch (e) { console.log('HOOK falhou: ' + e.message); app.quit(); }
});
