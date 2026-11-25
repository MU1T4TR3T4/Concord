// Portão de voz: roda na thread de áudio, então continua preciso mesmo com a janela minimizada.
// Modo "voice": abre quando o volume passa do limite e segura um pouco depois que a fala para.
// Modo "ptt": abre só enquanto a tecla de falar está apertada.
class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'voice';
    this.threshold = 0.02;
    this.ptt = false;
    this.holdUntil = 0;
    this.gain = 0;
    this.open = false;
    this.peak = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const ch = input[0];
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (rms > this.peak) this.peak = rms;

    // currentTime é global do AudioWorklet, em segundos.
    if (this.mode === 'ptt') {
      if (this.ptt) this.holdUntil = currentTime + 0.15;
    } else if (rms >= this.threshold) {
      this.holdUntil = currentTime + 0.4;
    }
    const open = currentTime < this.holdUntil;

    // Abre rápido (não corta a primeira sílaba) e fecha suave (sem estalo).
    const target = open ? 1 : 0;
    const step = open ? 0.25 : 0.02;
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || ch;
      const dst = output[c];
      let g = this.gain;
      for (let i = 0; i < dst.length; i++) {
        g += (target - g) * step;
        dst[i] = src[i] * g;
      }
      if (c === output.length - 1) this.gain = g;
    }

    // Avisa a interface ~20 vezes por segundo (medidor e "falando").
    if (++this.blocks >= 18 || open !== this.open) {
      this.port.postMessage({ level: this.peak, open });
      this.open = open;
      this.blocks = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('concord-gate', GateProcessor);
