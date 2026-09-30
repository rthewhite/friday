/**
 * Transport-agnostic Gemini Live session.
 * Push 16 kHz mono s16le PCM in with sendAudio(); receive Events via onEvent.
 * Tool calls run in the background so audio keeps streaming. The tools offered in
 * the `voice` channel are snapshotted when the session opens (Gemini binds them then).
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
import type { ConversationRecorder } from "./conversations/recorder.js";

export type Event =
  | { kind: "audio"; data: Buffer }
  | { kind: "interrupted" }
  | { kind: "turn_complete" }
  | { kind: "user_text"; data: string }
  | { kind: "bot_text"; data: string }
  | { kind: "tool_call"; data: { name: string; args: unknown } }
  | { kind: "tool_result"; data: { name: string; result: unknown } }
  | { kind: "closed"; data?: string };

/** Trailing characters skipped when deciding whether spoken words end with a question. */
const CLOSING = /[\s"'“”‘’«»)\]}」』]+$/u;
const QUESTION_MARKS = new Set(["?", "？", "؟"]);

/** True when the text's last character, past closing quotes and brackets, is a question mark. */
export function endsWithQuestion(text: string): boolean {
  return QUESTION_MARKS.has(text.replace(CLOSING, "").at(-1) ?? "");
}

/** The subset of the Live API the session uses; tests inject a fake. `apiKey` is the key resolved at open. */
export type LiveConnect = (params: LiveConnectParameters, apiKey: string) => Promise<Pick<Session, "sendRealtimeInput" | "sendClientContent" | "sendToolResponse" | "close">>;

export interface SessionOptions {
  connect?: LiveConnect;
  /** Gemini API key, resolved once when the session opens (core config: core scope, global, env). */
  geminiKey?: () => string | undefined;
  log?: Pick<Console, "log" | "error">;
  /** Records the conversation (transcripts, typed input, tools, end reason). Never changes what is emitted. */
  recorder?: ConversationRecorder;
  /**
   * The system instruction, built once when the session opens and kept for its lifetime (base, voice
   * part, module context). Defaults to the fixed voice prompt.
   */
  systemPrompt?: () => string;
}

export class GeminiSession {
  private session?: Awaited<ReturnType<LiveConnect>>;
  private closed = false;
  /** Set when a tool asked to end the conversation; we close after the model's turn finishes. */
  private endRequested?: string;
  private idleTimer?: NodeJS.Timeout;
  /** Friday's spoken words in the current turn, checked for a trailing question when it completes. */
  private turnText = "";
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
    const connect: LiveConnect = this.opts.connect ?? ((p, apiKey) => new GoogleGenAI({ apiKey }).live.connect(p));
    const apiKey = (this.opts.geminiKey ?? (() => settings.apiKey))() ?? "";
    const decls = this.registry.declarations("voice") as FunctionDeclaration[];
    const systemInstruction = (this.opts.systemPrompt ?? (() => settings.systemPrompt))();
    this.session = await connect({
      model: settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction,
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
    }, apiKey);
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
    this.opts.recorder?.user(text, "text");
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
      this.opts.recorder?.interrupted();
    }
    if (sc.inputTranscription?.text) {
      if (settings.logTranscripts) this.log.log(`gemini: heard ${JSON.stringify(sc.inputTranscription.text)}`);
      this.clearIdle(); // the user is talking again
      this.onEvent({ kind: "user_text", data: sc.inputTranscription.text });
      this.opts.recorder?.user(sc.inputTranscription.text, "speech");
    }
    if (sc.outputTranscription?.text) {
      this.turnText += sc.outputTranscription.text;
      this.onEvent({ kind: "bot_text", data: sc.outputTranscription.text });
      this.opts.recorder?.assistant(sc.outputTranscription.text);
    }
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) this.onEvent({ kind: "audio", data: Buffer.from(p.inlineData.data, "base64") });
    }
    if (sc.turnComplete) {
      this.onEvent({ kind: "turn_complete" });
      this.opts.recorder?.turnComplete();
      const askedQuestion = endsWithQuestion(this.turnText);
      this.turnText = "";
      if (this.endRequested && askedQuestion) {
        // The model asked something and ended in the same turn: let the user answer, and let the
        // idle timer end it if they don't. A later turn has to ask for the end again.
        this.log.log("gemini: end requested after a question, keeping the session open");
        this.endRequested = undefined;
        this.armIdle("ended: no follow-up (end after question)");
      } else if (this.endRequested) this.finish(`ended: ${this.endRequested}`);
      else this.armIdle();
    }
  }

  /** Close once the user has been silent for idleTimeoutMs after a turn, unless a tool is still pending. */
  private armIdle(reason = "ended: no follow-up"): void {
    this.clearIdle();
    if (!settings.idleTimeoutMs || this.toolsInFlight > 0) return;
    this.idleTimer = setTimeout(() => this.finish(reason), settings.idleTimeoutMs);
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
    const recorded = this.opts.recorder?.tool(name, args);
    this.toolsInFlight++;
    this.clearIdle();
    // Absent in the session's first exchange: nothing of it is stored until the turn ends.
    const conversationId = this.opts.recorder?.conversationId;
    const { result, scheduling, endConversation } = await this.registry.callTool(name, args, { channel: "voice", conversationId });
    this.toolsInFlight--;
    recorded?.result(result);
    this.onEvent({ kind: "tool_result", data: { name, result } });
    if (endConversation !== undefined) this.endRequested = endConversation;
    this.session?.sendToolResponse({ functionResponses: [{ id, name, response: { ...result, scheduling } }] });
  }

  private emitClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.onEvent({ kind: "closed", data: reason });
    this.opts.recorder?.end(reason);
  }

  close(): void {
    if (this.closed) return;
    this.session?.close();
    this.emitClosed("client closed");
  }
}
