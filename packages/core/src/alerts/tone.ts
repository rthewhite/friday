/**
 * The tone an alert session opens with: three rising two-note chimes, about two seconds of 24 kHz mono s16le,
 * synthesised here so no audio file ships with Friday. Each note fades in and out so nothing clicks.
 */

const NOTES_HZ = [1046.5, 1318.5]; // C6, E6
const NOTE_MS = 160;
const NOTE_GAP_MS = 60;
const CHIME_GAP_MS = 300;
const CHIMES = 3;
const FADE_MS = 10;
/** −12 dBFS. */
export const TONE_PEAK = Math.round(32767 * 10 ** (-12 / 20));

export function alertTone(rate = 24_000): Buffer {
  const samples = (ms: number) => Math.round((rate * ms) / 1000);
  const note = (hz: number): number[] => {
    const n = samples(NOTE_MS), fade = samples(FADE_MS);
    return Array.from({ length: n }, (_, i) => {
      const env = Math.min(1, i / fade, (n - 1 - i) / fade);
      return Math.round(TONE_PEAK * env * Math.sin((2 * Math.PI * hz * i) / rate));
    });
  };
  const silence = (ms: number): number[] => new Array(samples(ms)).fill(0);
  const out: number[] = [];
  for (let c = 0; c < CHIMES; c++) {
    if (c > 0) out.push(...silence(CHIME_GAP_MS));
    out.push(...note(NOTES_HZ[0]), ...silence(NOTE_GAP_MS), ...note(NOTES_HZ[1]));
  }
  out.push(...silence(CHIME_GAP_MS)); // a breath before Friday speaks
  const buf = Buffer.alloc(out.length * 2);
  out.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}
