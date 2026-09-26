/**
 * Transport-agnostic Gemini Live session.
 * Push 16 kHz mono s16le PCM in with sendAudio(); receive Events via onEvent.
 * Tool calls run in the background so audio keeps streaming. The tool list is
 * snapshotted from the registry when the session opens (Gemini binds it then).
 */
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  type FunctionDeclaration,
  type LiveConnectParameters,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import type { ToolRegistry } from "@friday/sdk";
import { settings } from "./config.js";

export type Event =
  | { kind: "audio"; data: Buffer }
  | { kind: "interrupted" }
  | { kind: "turn_complete" }
  | { kind: "user_text"; data: string }
  | { kind: "bot_text"; data: string }
  | { kind: "tool_call"; data: { name: string; args: unknown } }
  | { kind: "tool_result"; data: { name: string; result: unknown } }
  | { kind: "closed"; data?: string };

/** The subset of the Live API the session uses; tests inject a fake. */
export type LiveConnect = (params: LiveConnectParameters) => Promise<Pick<Session, "sendRealtimeInput" | "sendClientContent" | "sendToolResponse" | "close">>;

export interface SessionOptions {
  connect?: LiveConnect;
  log?: Pick<Console, "log" | "error">;
}

export class GeminiSession {
  private session?: Awaited<ReturnType<LiveConnect>>;
  private closed = false;
  /** Set when a tool asked to end the conversation; we close after the model's turn finishes. */
  private endRequested?: string;
  private idleTimer?: NodeJS.Timeout;
  private toolsInFlight = 0;
  private readonly log: Pick<Console, "log" | "error">;

  constructor(
    private readonly onEvent: (e: Event) => void,
    private readonly registry: ToolRegistry,
    private readonly opts: SessionOptions = {},
  ) {
    this.log = opts.log ?? console;
  }

  async open(): Promise<void> {
    const connect: LiveConnect =
      this.opts.connect ?? ((p) => new GoogleGenAI({ apiKey: settings.apiKey }).live.connect(p));
    const decls = this.registry.declarations() as FunctionDeclaration[];
    this.session = await connect({
      model: settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: settings.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity:
              settings.vadStartSensitivity === "HIGH"
                ? StartSensitivity.START_SENSITIVITY_HIGH
                : StartSensitivity.START_SENSITIVITY_LOW,
            prefixPaddingMs: settings.vadPrefixPaddingMs,
          },
        },
        tools: [{ functionDeclarations: decls }],
      },
      callbacks: {
        onmessage: (m) => this.handle(m),
        onerror: (e) => this.log.error("gemini error", e.message),
        onclose: (e) => this.emitClosed(e.reason),
      },
    });
    this.log.log(`gemini session open (${settings.model}, ${decls.length} tools, vad ${settings.vadStartSensitivity}/${settings.vadPrefixPaddingMs}ms)`);
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

  /** Exposed for tests that drive the session without a Live connection. */
  handle(m: LiveServerMessage): void {
    for (const fc of m.toolCall?.functionCalls ?? []) void this.runTool(fc.id, fc.name, fc.args);
    const sc = m.serverContent;
    if (!sc) return;
    // Gemini flags its own turn as interrupted when the end_conversation tool response
    // arrives; forwarding that would make clients cut Friday's final words.
    if (sc.interrupted && !this.endRequested) {
      this.log.log("gemini: interrupted");
      this.onEvent({ kind: "interrupted" });
    }
    if (sc.inputTranscription?.text) {
      if (settings.logTranscripts) this.log.log(`gemini: heard ${JSON.stringify(sc.inputTranscription.text)}`);
      this.clearIdle(); // the user is talking again
      this.onEvent({ kind: "user_text", data: sc.inputTranscription.text });
    }
    if (sc.outputTranscription?.text) this.onEvent({ kind: "bot_text", data: sc.outputTranscription.text });
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) this.onEvent({ kind: "audio", data: Buffer.from(p.inlineData.data, "base64") });
    }
    if (sc.turnComplete) {
      this.onEvent({ kind: "turn_complete" });
      if (this.endRequested) this.finish(`ended: ${this.endRequested}`);
      else this.armIdle();
    }
  }

  /** Close once the user has been silent for idleTimeoutMs after a turn, unless a tool is still pending. */
  private armIdle(): void {
    this.clearIdle();
    if (!settings.idleTimeoutMs || this.toolsInFlight > 0) return;
    this.idleTimer = setTimeout(() => this.finish("ended: no follow-up"), settings.idleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.log.log(`gemini session ${reason}`);
    this.session?.close();
    this.emitClosed(reason);
  }

  private async runTool(id?: string, name?: string, args?: Record<string, unknown>): Promise<void> {
    if (!name) return;
    this.onEvent({ kind: "tool_call", data: { name, args } });
    this.toolsInFlight++;
    this.clearIdle();
    const { result, scheduling, endConversation } = await this.registry.callTool(name, args);
    this.toolsInFlight--;
    this.onEvent({ kind: "tool_result", data: { name, result } });
    if (endConversation !== undefined) this.endRequested = endConversation;
    this.session?.sendToolResponse({ functionResponses: [{ id, name, response: { ...result, scheduling } }] });
  }

  private emitClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.onEvent({ kind: "closed", data: reason });
  }

  close(): void {
    if (this.closed) return;
    this.session?.close();
    this.emitClosed("client closed");
  }
}
