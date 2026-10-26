/** Page types and profile rules, shared by the store, the nightly pass and the portal UI (no Node or database imports). */
export const PAGE_TYPES = ["person", "place", "project", "other"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** The profile's instructions, at most this many characters (hybrid-profile D2). */
export const INSTRUCTIONS_MAX = 2000;

/** Whether the user's page still has the name the upgrade gave it (`Me`, `Me 2`, …) rather than theirs. */
export const unnamedSubject = (name: string): boolean => /^me(\s+\d+)?$/i.test(name.trim());

/** Whether an entity means the user (`me`, `profile`): the tools resolve it to the subject page (hybrid-profile D4). */
export const isSelf = (entity: string): boolean => ["me", "profile"].includes(entity.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase());
