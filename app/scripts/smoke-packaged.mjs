// Abre o app empacotado por alguns segundos e confere, pelo protocolo de depuração, que a
// interface carregou e que as pontes nativas (atualização, captura, apertar-para-falar) respondem.
// Uso: node scripts/smoke-packaged.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = join(import.meta.dirname, '../release/win-unpacked/Concord.exe');
// Perfil temporário: não mexe na conta logada do app instalado.
const profile = mkdtempSync(join(tmpdir(), 'concord-smoke-'));
// O último argumento simula o Windows abrindo o app por um link de convite.
const child = spawn(exe, ['--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'concord://convite/TESTE2345/'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let result = { error: 'não conectou' };
try {
  let page;
  for (let i = 0; i < 20 && !page; i++) {
    await sleep(700);
    page = await fetch('http://127.0.0.1:9333/json').then((r) => r.json()).then((l) => l.find((p) => p.type === 'page')).catch(() => null);
  }
  if (!page) throw new Error('página não apareceu');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const evaluate = (expression) => new Promise((resolve) => {
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description ?? m); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  await sleep(1500);
  result = await evaluate(`(async () => {
    const out = { url: location.protocol, tela: document.querySelector('.auth-card') ? 'login' : document.querySelector('.shell') ? 'app' : 'vazia' };
    out.versao = await window.concord.update.version();
    out.conviteNaTelaDeLogin = Boolean(document.querySelector('.auth-card .success'));
    const fontes = await window.concord.capture.sources();
    out.fontesDeCaptura = fontes.length;
    // Controle remoto: a biblioteca nativa carrega dentro do app empacotado e aceita uma tela?
    out.controleDisponivel = await window.concord.control.available();
    const tela = fontes.find((f) => f.id.startsWith('screen:'));
    out.controleNaTela = tela ? await window.concord.control.start(tela.id) : 'sem tela';
    await window.concord.control.stop();
    out.pttConfigura = await window.concord.ptt.configure({ type: 'key', code: 58 });
    await window.concord.ptt.configure(null);
    const ctx = new AudioContext();
    try { await ctx.audioWorklet.addModule(new URL('gate-worklet.js', document.baseURI).href); out.portaoDeVoz = 'carregou'; }
    catch (e) { out.portaoDeVoz = 'falhou: ' + e.message; }
    await ctx.close();
    out.logo = await new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth); i.onerror = () => r('falhou'); i.src = './icon-192.png'; });
    return out;
  })()`);
  ws.close();
} catch (e) {
  result = { error: String(e) };
}
console.log(JSON.stringify(result, null, 1));
child.kill();
