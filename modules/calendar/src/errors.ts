/**
 * Errors the calendar tools report. Each message is written for the model to pass on, so it says what happened
 * and what to do next; none of them ever contains the password or a request URL.
 */

/** iCloud refused the sign-in (HTTP 401). The usual cause is a normal Apple ID password or a revoked one. */
export class CredentialRejectedError extends Error {
  constructor(username: string) {
    super(
      `iCloud rejected the sign-in for ${username}. ICLOUD_APP_PASSWORD must be an app-specific password, not the ` +
        "Apple ID password: create one at account.apple.com under Sign-In and Security > App-Specific Passwords and " +
        "save it in Settings > Configuration. An earlier one may have been revoked, which also happens to all of them " +
        "when the Apple ID password changes.",
    );
    this.name = "CredentialRejectedError";
  }
}

/** The calendar or event can't be written by Friday: a read-only calendar, or an invitation from someone else. */
export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

/** The event changed or disappeared in iCloud after Friday last saw it. `current` is how it looks now, if it exists. */
export class StaleEventError extends Error {
  constructor(message: string, readonly current?: unknown) {
    super(message);
    this.name = "StaleEventError";
  }
}

/** An event id Friday never handed out, or one that expired. */
export class UnknownEventError extends Error {
  constructor(id: string) {
    super(`There is no event with id "${id}" (ids expire after a while). List the events again with calendar_list_events and use an id from that result.`);
    this.name = "UnknownEventError";
  }
}

/** A confirmation token that is unknown, expired or already used. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/** A logged change that can't be undone (already undone, an undo itself, or its calendar is gone). */
export class NotUndoableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotUndoableError";
  }
}

/** Bad tool or route input: the message names the parameter and what is wrong with it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Any other iCloud failure: network, timeout, server error, or a response that doesn't parse. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** A conditional write found the object changed (412) or gone (404). Internal: the service turns it into a StaleEventError. */
export class PreconditionFailed extends Error {
  constructor(readonly status: number) {
    super(`precondition failed (HTTP ${status})`);
    this.name = "PreconditionFailed";
  }
}
