/**
 * The person behind a request, a call or a prompt, as modules see them. Never an email, a subject or a token.
 * Absent where nobody logged in: a voice device's session, a scheduled run, MCP and remote tools.
 */

export type UserRole = "admin" | "member";

/** Who a tool call or a prompt is for. */
export interface CallUser {
  id: string;
  name: string;
}

/** Who made a module route request, with their role so a route can keep something for admins. */
export interface RequestUser extends CallUser {
  role: UserRole;
}
