/** The calendar tools, on voice and chat. Descriptions are what the model reads; keep them about behaviour. */
import { Type, type ModuleContext } from "@friday/sdk";
import type { CalendarService, CreateArgs, ListArgs } from "./service.js";

const TIME_HINT = "ISO 8601 date-time like 2026-10-08T15:00 (without an offset it is household time)";

export function defineCalendarTools(ctx: ModuleContext, service: CalendarService): void {
  ctx.defineTool<ListArgs>({
    name: "calendar_list_events",
    description:
      "List events from the user's calendar, with recurring events expanded. Use it for questions about the schedule " +
      "beyond today and tomorrow (those are already in your context), to search for an event, and always before " +
      "editing or deleting one: edits and deletions take an id from this result. Without from it starts today; without " +
      "to it covers 7 days, or 365 days when a query is given. At most 366 days and 50 events per call.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        from: { type: Type.STRING, description: `Start of the range: a date (YYYY-MM-DD, from the start of that day) or an ${TIME_HINT}` },
        to: { type: Type.STRING, description: `End of the range: a date (that whole day included) or an ${TIME_HINT}` },
        query: { type: Type.STRING, description: "Only events whose title, location or notes contain every one of these words" },
        calendar: { type: Type.STRING, description: "Only this calendar, by name" },
      },
    },
    handler: (args) => service.list(args),
  });

  ctx.defineTool<CreateArgs>({
    name: "calendar_create_event",
    description:
      "Add an event to the user's calendar. It is created right away, so make sure you have the title, day and time " +
      "right; afterwards tell the user what was created (the result's say text) and mention any overlaps. A timed event " +
      "lasts an hour unless end is given; an all-day event takes dates. Without calendar it goes to the default calendar.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "What the event is" },
        start: { type: Type.STRING, description: `When it starts: an ${TIME_HINT}, or a date (YYYY-MM-DD) for an all-day event` },
        end: { type: Type.STRING, description: "When it ends: a date-time, or for an all-day event its last day (inclusive)" },
        allDay: { type: Type.BOOLEAN, description: "True for an all-day event (implied when start is a date)" },
        location: { type: Type.STRING, description: "Where, as an address or place name" },
        notes: { type: Type.STRING, description: "Extra notes" },
        calendar: { type: Type.STRING, description: "Calendar name; leave out for the default" },
        repeat: { type: Type.STRING, enum: ["daily", "weekly", "monthly", "yearly"], description: "Repeat the event this often" },
        repeatUntil: { type: Type.STRING, description: "Last day of the repetition (YYYY-MM-DD, inclusive); leave out to repeat forever" },
      },
      required: ["title", "start"],
    },
    handler: (args, call) => service.create(args, call),
  });
}
