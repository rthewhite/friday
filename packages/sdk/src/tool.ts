/**
 * Tool types shared by core and modules. Kept free of any Gemini dependency so
 * modules only need `@friday/sdk`; core adapts declarations to `@google/genai`.
 */

import type { ConversationChannel } from "./conversations.js";

/** How Gemini surfaces a tool result once it arrives. */
export type Scheduling = "INTERRUPT" | "WHEN_IDLE" | "SILENT";

/**
 * A tool handler's return value. Two keys are reserved and stripped before the
 * result reaches the model: `scheduling` (per-call override) and
 * `endConversation` (a string reason asking the session to close after the turn).
 */
export type ToolResult = Record<string, unknown>;

/** Parameter schema types, value-compatible with `@google/genai`'s `Type` enum. */
export const Type = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
} as const;
export type SchemaType = (typeof Type)[keyof typeof Type];

/** Structural subset of Gemini's parameter `Schema`. */
export interface Schema {
  type?: SchemaType;
  description?: string;
  enum?: string[];
  format?: string;
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters?: Schema;
  /** Raw JSON Schema alternative to `parameters` (used for MCP tools). */
  parametersJsonSchema?: unknown;
  /** Default scheduling for this tool's results. */
  scheduling?: Scheduling;
  /** Conversation channels the tool is offered in; both when omitted. */
  channels?: ConversationChannel[];
  handler: (args: A) => ToolResult | Promise<ToolResult>;
}

/** What is sent to the model for one tool. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Schema;
  parametersJsonSchema?: unknown;
}

export const SCHEDULINGS: readonly Scheduling[] = ["INTERRUPT", "WHEN_IDLE", "SILENT"];
export const CHANNELS: readonly ConversationChannel[] = ["voice", "chat"];
