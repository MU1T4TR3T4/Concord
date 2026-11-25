// Teste empírico da correção do eco: o áudio capturado junto com a tela inclui o som
// tocado pelo próprio app? E o som de outros programas continua entrando?
// Uso: npx electron scripts/echo-test.cjs   (toca sons baixos por alguns segundos)
const { app, BrowserWindow, desktopCapturer, session, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

let mode = 'loopback';

const html = `<script>
const { ipcRenderer } = require('electron');
async function measure(label, audioConstraint) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraint });
  const ctx = new AudioContext();
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
  const buf = new Float32Array(2048); let peak = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    peak = Math.max(peak, Math.sqrt(s / buf.length));
    await new Promise(r => setTimeout(r, 50));
  }
  stream.getTracks().forEach(t => t.stop()); await ctx.close();
  return { label, peakRms: +peak.toFixed(5) };
}
(async () => {
  const out = [];
  try {
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const g = ctx.createGain();
    g.gain.value = 0.05; osc.frequency.value = 440; osc.connect(g).connect(ctx.destination); osc.start();
    await new Promise(r => setTimeout(r, 500));
    await ipcRenderer.invoke('mode', 'loopback');
    out.push(await measure('som do proprio app, captura antiga (loopback)', true));
    await ipcRenderer.invoke('mode', 'loopbackWithoutChrome');
    out.push(await measure('som do proprio app, captura corrigida', { restrictOwnAudio: true }));
    g.gain.value = 0;
    await ipcRenderer.invoke('external');
    out.push(await measure('som de OUTRO programa, captura corrigida', { restrictOwnAudio: true }));
  } catch (e) { out.push({ error: String(e) }); }
  ipcRenderer.send('done', out);
})();
</script>`;

app.whenReady().then(() => {
  ipcMain.handle('mode', (_e, m) => { mode = m; });
  ipcMain.handle('external', () => {
    const cmd = "1..3 | ForEach-Object { (New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync() }";
    spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
  });
  ipcMain.on('done', (_e, out) => { console.log('RESULTADO ' + JSON.stringify(out, null, 1)); app.quit(); });
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const [src] = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: src, audio: mode });
  });
  const w = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  const file = join(tmpdir(), 'concord-echo-test.html');
  writeFileSync(file, html);
  w.loadFile(file);
  setTimeout(() => { console.log('TEMPO ESGOTADO'); app.quit(); }, 40000);
});
