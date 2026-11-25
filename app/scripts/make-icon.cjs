// Gera todos os tamanhos de ícone do Concord a partir de build/icon-source.png.
// Uso: npm run icons
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const source = pathToFileURL(join(root, 'build/icon-source.png')).href;

// "rounded": a arte como veio, com os cantos arredondados transparentes (Windows, navegador).
// "full": a arte sobre um quadrado roxo cheio (iPhone e ícones "maskable" do Android, que recortam sozinhos).
const page = (kind) => `<html><body style="margin:0;overflow:hidden;width:1024px;height:1024px;
  background:${kind === 'full' ? 'linear-gradient(#8b3dff,#5b12f2)' : 'transparent'}">
  <div style="width:1024px;height:1024px;border-radius:22%;overflow:hidden">
    <img src="${source}" style="width:1024px;height:1024px;display:block;transform:scale(1.015)">
  </div></body></html>`;
// A imagem original vem com os cantos pretos (não transparentes); o recorte arredondado acima
// tira esse preto, deixando transparente ("rounded") ou roxo ("full").

async function render(kind) {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true,
    webPreferences: { offscreen: true, webSecurity: false } });
  const file = join(require('node:os').tmpdir(), `concord-icon-${kind}.html`);
  writeFileSync(file, page(kind));
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  win.destroy();
  return img;
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // não encerra entre um desenho e outro
app.whenReady().then(async () => {
  const pub = join(root, 'src/renderer/public');
  mkdirSync(pub, { recursive: true });
  const rounded = await render('rounded');
  const full = await render('full');
  const out = (img, size, file) => writeFileSync(file, img.resize({ width: size, height: size, quality: 'best' }).toPNG());
  out(rounded, 1024, join(root, 'build/icon.png')); // instalador e janela do Windows
  out(rounded, 512, join(pub, 'icon-512.png'));
  out(rounded, 192, join(pub, 'icon-192.png'));
  out(full, 512, join(pub, 'icon-maskable-512.png'));
  out(full, 180, join(pub, 'apple-touch-icon.png'));
  console.log('icones gerados; base', rounded.getSize());
  app.quit();
});
