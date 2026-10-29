/**
 * The sidebar's items. Assistant pages first, then one item per module UI the server reports as usable, then the
 * System pages (Modules first), which only admins see. A section without items is not shown.
 */
import { visibleItems, type Role } from "./auth.js";

export interface NavEntry {
  to: string;
  label: string;
  icon?: string;
  group: string;
}

/** What the sidebar needs to know about a module UI. */
export interface NavUi {
  id: string;
  nav: { label: string; icon?: string; order?: number };
}

export const NAV_GROUPS = ["Assistant", "Modules", "System"];

const ASSISTANT: NavEntry[] = [
  { to: "/", label: "Talk", icon: "mic", group: "Assistant" },
  { to: "/chat", label: "Chat", icon: "message", group: "Assistant" },
  { to: "/conversations", label: "Conversations", icon: "chat", group: "Assistant" },
  { to: "/agents", label: "Agents", icon: "bot", group: "Assistant" },
];

const SYSTEM: NavEntry[] = [
  { to: "/settings/modules", label: "Modules", icon: "grid", group: "System" },
  { to: "/settings/config", label: "Configuration", icon: "settings", group: "System" },
  { to: "/settings/connections", label: "Connections", icon: "link", group: "System" },
  { to: "/settings/devices", label: "Voice devices", icon: "speaker", group: "System" },
  { to: "/settings/alerts", label: "Alerts", icon: "bell", group: "System" },
  { to: "/settings/keys", label: "Remote modules", icon: "key", group: "System" },
  { to: "/settings/jobs", label: "Jobs", icon: "clock", group: "System" },
  { to: "/settings/users", label: "Users", icon: "user", group: "System" },
];

/** The items the sidebar shows to a user with this role; `hasPage(id)` says whether a module's UI can be opened. */
export function navItems(uis: readonly NavUi[], hasPage: (id: string) => boolean, role: Role | undefined): NavEntry[] {
  const modules = uis
    .filter((u) => hasPage(u.id))
    .sort((a, b) => (a.nav.order ?? 100) - (b.nav.order ?? 100) || a.nav.label.localeCompare(b.nav.label))
    .map((u) => ({ to: `/m/${u.id}`, label: u.nav.label, icon: u.nav.icon, group: "Modules" }));
  return visibleItems([...ASSISTANT, ...modules, ...SYSTEM], role);
}
