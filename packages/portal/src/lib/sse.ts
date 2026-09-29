/**
 * Incremental parser for a `text/event-stream` body read with fetch (EventSource can't POST).
 * Feed it decoded chunks as they arrive; it returns the events completed so far and keeps the rest.
 * Comment lines (`: ping`) are dropped; several `data:` lines of one event join with a newline.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const out: SseEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const e = parseBlock(block);
      if (e) out.push(e);
    }
    return out;
  }
}

function parseBlock(block: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}
