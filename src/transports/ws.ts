/**
 * Raw WebSocket transport, shared by the web UI and microcontrollers (ESP32).
 *
 *   client -> server : binary = 16 kHz mono s16le PCM
 *                      text   = JSON {"type":"text","text":"..."}
 *   server -> client : binary = 24 kHz mono s16le PCM
 *                      text   = JSON events: interrupted, user_text, bot_text,
 *                               tool_call, tool_result, turn_complete, closed
 * On "interrupted" the client must drop its playback buffer.
 */
import type { WebSocket } from "ws";
import { GeminiSession } from "../session.js";

export async function serveWs(ws: WebSocket): Promise<void> {
  const g = new GeminiSession((ev) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ev.kind === "audio") ws.send(ev.data);
    else ws.send(JSON.stringify({ type: ev.kind, data: "data" in ev ? ev.data : undefined }));
    if (ev.kind === "closed") ws.close();
  });

  try {
    await g.open();
  } catch (e) {
    console.error("could not open gemini session", e);
    ws.close(1011, "gemini unavailable");
    return;
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) void g.sendAudio(raw as Buffer);
    else {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "text") g.sendText(msg.text);
    }
  });
  ws.on("close", () => g.close());
  ws.on("error", () => g.close());
}
