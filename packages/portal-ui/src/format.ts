/** Date and time formatting for the portal: Dutch notation, dd-mm-yyyy and a 24-hour clock. */
const dateTime = new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateOnly = new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const parse = (v: string | number | Date | null | undefined): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `26-09-2026, 22:10:07`; `fallback` when empty or invalid. */
export const formatDateTime = (v: string | number | Date | null | undefined, fallback = ""): string => { const d = parse(v); return d ? dateTime.format(d) : fallback; };
/** `26-09-2026` */
export const formatDate = (v: string | number | Date | null | undefined, fallback = ""): string => { const d = parse(v); return d ? dateOnly.format(d) : fallback; };
/** `22:10:07` */
export const formatTime = (v: string | number | Date | null | undefined, fallback = ""): string => { const d = parse(v); return d ? timeOnly.format(d) : fallback; };
