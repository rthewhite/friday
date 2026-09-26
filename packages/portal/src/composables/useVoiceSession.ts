/**
 * Browser voice client for /ws/audio: 16 kHz s16le capture through an AudioWorklet,
 * gapless 24 kHz playback, transcript and tool events. Behaviour follows the
 * web-client spec; see openspec/specs/web-client.
 */
import { onBeforeUnmount, ref } from "vue";

const OUT_RATE = 24000;

export type Entry = { id: number; kind: "user" | "bot" | "tool"; text: string };
export type State = "idle" | "connecting" | "live" | `error: ${string}`;

export function useVoiceSession() {
  const state = ref<State>("idle");
  const live = ref(false);
  const log = ref<Entry[]>([]);

  let ws: WebSocket | null = null;
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let playHead = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const current: { user: Entry | null; bot: Entry | null } = { user: null, bot: null };
  let seq = 0;

  const add = (kind: Entry["kind"], text: string): Entry => {
    log.value.push({ id: ++seq, kind, text });
    // Return the reactive proxy Vue stored, not the raw object, so later appends re-render.
    return log.value[log.value.length - 1]!;
  };
  const append = (role: "user" | "bot", text: string) => {
    if (!current[role]) current[role] = add(role, "");
    current[role]!.text += text;
  };

  const play = (pcm: ArrayBuffer) => {
    if (!ctx) return;
    const i16 = new Int16Array(pcm);
    const buf = ctx.createBuffer(1, i16.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = (i16[i] ?? 0) / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, playHead);
    src.start(at);
    playHead = at + buf.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
  };
  const flush = () => {
    for (const s of playing) { try { s.stop(); } catch { /* already stopped */ } }
    playing.clear();
    playHead = 0;
  };

  async function start(): Promise<void> {
    state.value = "connecting";
    log.value = [];
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/capture-worklet.js");
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/audio`);
    sock.binaryType = "arraybuffer";
    await new Promise<void>((ok, err) => { sock.onopen = () => ok(); sock.onerror = () => err(new Error("websocket failed")); });
    ws = sock;

    node = new AudioWorkletNode(ctx, "capture");
    node.port.onmessage = (e) => sock.readyState === WebSocket.OPEN && sock.send(e.data as ArrayBuffer);
    ctx.createMediaStreamSource(stream).connect(node);

    sock.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return play(e.data);
      const m = JSON.parse(e.data as string) as { type: string; data?: any };
      switch (m.type) {
        case "user_text": current.bot = null; append("user", m.data); break;
        case "bot_text": current.user = null; append("bot", m.data); break;
        case "turn_complete": current.user = current.bot = null; break;
        case "interrupted": flush(); current.bot = null; break;
        case "tool_call": add("tool", `→ ${m.data.name}(${JSON.stringify(m.data.args)})`); break;
        case "tool_result": add("tool", `← ${m.data.name}: ${JSON.stringify(m.data.result)}`); break;
        case "closed": add("tool", `session closed: ${m.data ?? ""}`); stop(true); break;
      }
    };
    sock.onclose = () => stop(true);
    state.value = "live";
    live.value = true;
  }

  /** drain=true (server ended the conversation): stop the mic now but let queued speech finish playing. */
  function stop(drain = false): void {
    stream?.getTracks().forEach((t) => t.stop());
    node?.disconnect();
    if (ws) { ws.onclose = null; ws.close(); }
    const c = ctx;
    ws = ctx = stream = node = null;
    live.value = false;
    if (!state.value.startsWith("error")) state.value = "idle";
    current.user = current.bot = null;
    if (!c) return;
    const wait = drain ? Math.max(0, playHead - c.currentTime) * 1000 : 0;
    if (!drain) flush();
    setTimeout(() => { playing.clear(); playHead = 0; void c.close(); }, wait);
  }

  async function toggle(): Promise<void> {
    if (live.value) return stop();
    state.value = "idle";
    try {
      await start();
    } catch (e) {
      console.error(e);
      state.value = `error: ${e instanceof Error ? e.message : String(e)}`;
      stop();
    }
  }

  onBeforeUnmount(() => { if (live.value || ctx) stop(); });

  return { state, live, log, toggle, stop };
}
