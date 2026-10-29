/**
 * The person behind a request, a call or a prompt, as modules see them. Never an email, a subject or a token.
 * A voice device's session acts for the household owner and an agent run for its creator. Absent in MCP and remote
 * tools, and in a device's session while no owner is recorded.
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

/** The household's users as modules see them (`ctx.users`). In-process modules only. */
export interface ModuleUsers {
  /** The household owner, or `undefined` while none is recorded (a fresh install before the first admin login). */
  owner(): CallUser | undefined;
  /** Every user who is not disabled. */
  list(): CallUser[];
  /**
   * Called once, when the owner is first recorded. Returns an unsubscribe function; subscriptions also end when the
   * module is disposed or reloaded.
   */
  onOwner(handler: (owner: CallUser) => void | Promise<void>): () => void;
}
