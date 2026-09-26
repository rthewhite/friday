// Downsamples mic input to 16 kHz mono s16le and posts ~20 ms chunks.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.out = []; this.chunk = 320; // 20 ms @ 16 kHz
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        if (this.out.length >= this.chunk) {
          this.port.postMessage(new Int16Array(this.out).buffer);
          this.out = [];
        }
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
