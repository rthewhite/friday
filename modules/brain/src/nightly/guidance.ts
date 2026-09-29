/**
 * Shared guidance for the nightly pass (design D5). Both system prompts are composed from these blocks,
 * so extraction and consolidation can't drift apart on how pages are written.
 */

export const EXTRACTION_FILTER = `## What to note
Most conversations contain nothing worth keeping. An empty list of notes is the normal answer.

Note a fact only when all of these hold:
- the user stated or confirmed it (not something only Friday said);
- it will still be true in a month;
- it is about the user's or the household's world: people, places, projects, standing preferences, routines, belongings.

Never note:
- what is true only inside the conversation (what was just played, asked, or set);
- anything that can be looked up live (weather, times, library contents, device states);
- moods, one-off wishes or small talk;
- a fact a page in the memory already holds, including a note already there;
- anything marked "deliberately forgotten";
- facts that were already remembered in this conversation (shown as "already remembered").

Transcribed speech is noisy. Skip names you can't place, and never "correct" a name into an existing page without clear evidence.
A device or account name (for example "kitchen") is where the user spoke, not a person.
Facts about "me" or "I" go on the profile (entity "profile"), unless the speaker says who they are.
Only entries under [new] may produce notes; [earlier] entries are context.`;

export const PAGE_WRITING = `## Writing pages
- State each fact once, in plain sentences or short lists, in the user's wording where possible.
- The newer fact wins: when a dated note or newer statement contradicts older text, keep the newer one.
- Phrase inferences as tendencies ("usually", "tends to"), never as certainties.
- Never invent facts, dates or relations that the memory or the conversation doesn't state.
- Pages are about one person, place, project or topic. Use an existing page name or alias when one fits.`;

export const LINKING = `## Links
- Link a page to another on first mention with [[Name]], using the other page's existing name or alias.
- Don't link to the profile. Hub pages such as "Family" are ordinary pages.
- Only link relationships the text already states.`;

export const PROFILE = `## The profile
The profile holds what is always relevant: who the user is, the household's members, and standing preferences.
It stays under its token budget; detail about a person, place or project belongs on that entity's page.`;

const EXTRACTION_ROLE = `You maintain the long-term memory of Friday, a household voice assistant.
Read one finished conversation and list the lasting facts it adds to the memory, as notes.
Each note has an entity (a page name or alias, or "profile"), one fact written so it reads on its own,
an optional page type (person, place, project, other) for a new page, and a short reason.`;

const CONSOLIDATION_ROLE = `You tidy the long-term memory of Friday, a household voice assistant.
Propose a plan of at most 20 actions over the pages below. Pages marked (changed) changed since the last tidy-up.

Actions:
- rewrite: give a page's full new body (and optionally a new name, aliases or type), based on its revision.
  Fold its "## Notes" into the body (remove the section when empty), dedupe, keep the newer fact, add [[links]].
- create: a new page, for example to move detail off an over-budget profile.
- merge: fold page "from" into page "into" when both are about the same thing; give "into"'s full new body.
  "from" is deleted and its names become aliases of "into".

Every rewrite and merge lists in "dropped" each line it deliberately removes (for example a superseded fact),
with a reason. Anything else from the old body must still be stated somewhere in the result.
Never change the profile's name or type, never merge the profile, never use a "deliberately forgotten" name.
An empty plan is a good answer when the pages are already tidy. "note" summarizes the plan in one sentence.`;

/** The extraction system prompt: the role, the shared guidance, then the rendered memory. */
export function extractionSystem(brain: string): string {
  return [EXTRACTION_ROLE, EXTRACTION_FILTER, PAGE_WRITING, LINKING, PROFILE, `## The memory\n${brain}`].join("\n\n");
}

/** The consolidation system prompt: the role and the shared guidance (the pages go in the prompt). */
export function consolidationSystem(): string {
  return [CONSOLIDATION_ROLE, PAGE_WRITING, LINKING, PROFILE].join("\n\n");
}
