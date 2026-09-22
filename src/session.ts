/**
 * Transport-agnostic Gemini Live session.
 * Push 16 kHz mono s16le PCM in with sendAudio(); receive Events via onEvent.
 * Tool calls run in the background so audio keeps streaming.
 */
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";
import { settings } from "./config.js";
import { callTool, declarations } from "./tools/index.js";

export type Event =
  | { kind: "audio"; data: Buffer }
  | { kind: "interrupted" }
  | { kind: "turn_complete" }
  | { kind: "user_text"; data: string }
  | { kind: "bot_text"; data: string }
  | { kind: "tool_call"; data: { name: string; args: unknown } }
  | { kind: "tool_result"; data: { name: string; result: unknown } }
  | { kind: "closed"; data?: string };

export class GeminiSession {
  private session?: Session;
  private closed = false;

  constructor(private readonly onEvent: (e: Event) => void) {}

  async open(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: settings.apiKey });
    const decls = declarations();
    this.session = await ai.live.connect({
      model: settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: settings.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
        tools: [{ functionDeclarations: decls }],
      },
      callbacks: {
        onmessage: (m) => this.handle(m),
        onerror: (e) => console.error("gemini error", e.message),
        onclose: (e) => this.emitClosed(e.reason),
      },
    });
    console.log(`gemini session open (${settings.model}, ${decls.length} tools)`);
  }

  async sendAudio(pcm16k: Buffer): Promise<void> {
    if (this.closed) return;
    this.session?.sendRealtimeInput({
      audio: { data: pcm16k.toString("base64"), mimeType: `audio/pcm;rate=${settings.inputRate}` },
    });
  }

  sendText(text: string): void {
    this.session?.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }] });
  }

  private handle(m: LiveServerMessage): void {
    for (const fc of m.toolCall?.functionCalls ?? []) void this.runTool(fc.id, fc.name, fc.args);
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) this.onEvent({ kind: "interrupted" });
    if (sc.inputTranscription?.text) this.onEvent({ kind: "user_text", data: sc.inputTranscription.text });
    if (sc.outputTranscription?.text) this.onEvent({ kind: "bot_text", data: sc.outputTranscription.text });
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) this.onEvent({ kind: "audio", data: Buffer.from(p.inlineData.data, "base64") });
    }
    if (sc.turnComplete) this.onEvent({ kind: "turn_complete" });
  }

  private async runTool(id?: string, name?: string, args?: Record<string, unknown>): Promise<void> {
    if (!name) return;
    this.onEvent({ kind: "tool_call", data: { name, args } });
    const { result, scheduling } = await callTool(name, args);
    this.onEvent({ kind: "tool_result", data: { name, result } });
    this.session?.sendToolResponse({ functionResponses: [{ id, name, response: { ...result, scheduling } }] });
  }

  private emitClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onEvent({ kind: "closed", data: reason });
  }

  close(): void {
    if (this.closed) return;
    this.session?.close();
    this.emitClosed("client closed");
  }
}
