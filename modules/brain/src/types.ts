/** Page types, shared by the store and the portal UI (no Node or database imports). */
export const PAGE_TYPES = ["person", "place", "project", "other"] as const;
export type PageType = (typeof PAGE_TYPES)[number];
