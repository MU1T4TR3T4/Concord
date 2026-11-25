// Gera todos os ícones do Concord a partir do desenho em SVG abaixo.
// Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const INK = '#1b1f27';

// O mascote: um balão de conversa sorridente, piscando, com um moicano.
const face = `
  <path d="M342 356 L372 196 L440 318 L512 150 L584 318 L652 196 L682 356 Z" fill="${INK}" stroke="${INK}" stroke-width="34" stroke-linejoin="round"/>
  <path d="M512 318 C704 318 826 428 826 574 C826 720 704 830 512 830 C468 830 427 824 390 813 L262 884 L296 764 C232 714 198 648 198 574 C198 428 320 318 512 318 Z" fill="#fff"/>
  <ellipse cx="408" cy="548" rx="44" ry="60" fill="${INK}"/>
  <path d="M566 556 Q620 496 674 556" fill="none" stroke="${INK}" stroke-width="36" stroke-linecap="round"/>
  <path d="M396 668 Q520 772 652 652" fill="none" stroke="${INK}" stroke-width="36" stroke-linecap="round"/>
  <path d="M648 668 q26 -2 30 -30" fill="none" stroke="${INK}" stroke-width="26" stroke-linecap="round"/>`;

const defs = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ff9a70"/><stop offset="1" stop-color="#f2502f"/></linearGradient></defs>`;

// "rounded": cantos arredondados e fundo transparente (Windows, navegador).
// "full": quadrado cheio com o mascote menor (iPhone e ícones "maskable" do Android, que recortam sozinhos).
const svg = (kind) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${defs}
  ${kind === 'rounded' ? '<rect width="1024" height="1024" rx="228" fill="url(#g)"/>' : '<rect width="1024" height="1024" fill="url(#g)"/>'}
  <g transform="${kind === 'full' ? 'translate(512 512) scale(0.8) translate(-512 -512)' : ''}">${face}</g></svg>`;

async function render(kind) {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg(kind)}</body></html>`;
  const file = join(require('node:os').tmpdir(), 'concord-icon-' + kind + '.html');
  writeFileSync(file, html);
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  win.destroy();
  return img;
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // não encerra entre um desenho e outro
app.whenReady().then(async () => {
  const root = join(__dirname, '..');
  const pub = join(root, 'src/renderer/public');
  mkdirSync(join(root, 'build'), { recursive: true });
  const rounded = await render('rounded');
  const full = await render('full');
  const out = (img, size, file) => writeFileSync(file, img.resize({ width: size, height: size, quality: 'best' }).toPNG());
  out(rounded, 1024, join(root, 'build/icon.png')); // instalador e janela do Windows
  out(rounded, 512, join(pub, 'icon-512.png'));
  out(rounded, 192, join(pub, 'icon-192.png'));
  out(full, 512, join(pub, 'icon-maskable-512.png'));
  out(full, 180, join(pub, 'apple-touch-icon.png'));
  writeFileSync(join(root, 'build/icon.svg'), svg('rounded'));
  console.log('icones gerados; base', rounded.getSize());
  app.quit();
});
