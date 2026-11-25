// Confere, neste computador, que o controle remoto consegue mexer o mouse e que as travas funcionam.
// Uso: cd app && node scripts/control-test.mjs   (o cursor anda alguns pixels e volta)
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
const c = await import('../src/main/control.ts');
const koffi = globalThis.require('koffi');
const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('TestPoint', { x: 'int32', y: 'int32' });
const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(POINT))]);
const pos = () => { const p = { x: 0, y: 0 }; GetCursorPos(p); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? 'ok    ' : 'FALHA ') + name); };

ok(c.controlAvailable(), 'biblioteca do Windows carregou');
const api = c._test.load();
const v = api.virtualScreen();
ok(v.w > 0 && v.h > 0, `área de telas: ${v.w}x${v.h} em (${v.x},${v.y})`);
ok(c.applyInput([['r', 5, 5]]) === 'off', 'sem controle ativo nada é aplicado');

// tela inteira: movimento relativo e posição absoluta
const before = pos();
ok(c.startControl({ kind: 'screen', rect: { x: v.x, y: v.y, w: v.w, h: v.h } }).ok, 'controle de tela inicia');
c.applyInput([['r', 7, 5]]); await sleep(60);
const moved = pos();
ok(moved.x !== before.x || moved.y !== before.y, `movimento relativo andou o cursor: (${before.x},${before.y}) → (${moved.x},${moved.y})`);
c.applyInput([['m', 0.5, 0.5]]); await sleep(60);
const mid = pos();
ok(Math.abs(mid.x - (v.x + v.w / 2)) <= 2 && Math.abs(mid.y - (v.y + v.h / 2)) <= 2, `posição absoluta 50%/50% caiu no centro: (${mid.x},${mid.y})`);

// travas de teclado (sem enviar nada perigoso: só Shift)
c.applyInput([['k', 'MetaLeft', 1]]);
ok(!c._test.keysDown.has('MetaLeft'), 'tecla Windows é recusada');
c.applyInput([['k', 'AltLeft', 1], ['k', 'Tab', 1]]);
ok(c._test.keysDown.has('AltLeft') && !c._test.keysDown.has('Tab'), 'Alt+Tab é recusado');
c.applyInput([['k', 'F4', 1]]);
ok(!c._test.keysDown.has('F4'), 'Alt+F4 é recusado');
c.applyInput([['k', 'AltLeft', 0], ['k', 'ShiftLeft', 1]]);
ok(c._test.keysDown.has('ShiftLeft'), 'tecla comum (Shift) é aceita');
c.stopControl();
ok(c._test.keysDown.size === 0 && !c.controlActive(), 'parar solta todas as teclas');

// janela: só vale se estiver em primeiro plano
const fg = api.foreground();
ok(c.startControl({ kind: 'window', hwnd: 0x7ffffff0 }).ok === false, 'janela inexistente é recusada');
if (fg) {
  const r = api.windowRect(fg);
  ok(Boolean(r && r.w > 0), `limites da janela em primeiro plano: ${r?.w}x${r?.h}`);
}
// volta o cursor para onde estava
c.startControl({ kind: 'screen', rect: { x: v.x, y: v.y, w: v.w, h: v.h } });
c.applyInput([['m', (before.x - v.x) / (v.w - 1), (before.y - v.y) / (v.h - 1)]]);
c.stopControl();
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
