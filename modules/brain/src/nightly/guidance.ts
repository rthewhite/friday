/**
 * Shared guidance for the nightly pass (design D5). The system prompts are composed from these blocks,
 * so extraction, consolidation and the summary can't drift apart on how pages are written. Blocks that
 * mention the user take the subject page's name (hybrid-profile D6).
 */

/**
 * Bump when a guidance change should make existing brains be reconsidered: the next consolidation then
 * runs even if no page changed, with the subject page marked as changed, and the summary is generated again.
 */
export const GUIDANCE_VERSION = 3;

/** How the guidance refers to the user: the subject page's name, or "the user" while it is still `Me`. */
export function userName(subject: string): string {
  return /^me(\s+\d+)?$/i.test(subject.trim()) ? "the user" : subject.trim();
}

const possessive = (user: string) => `${user}'s`;

export function extractionFilter(subject: string): string {
  const user = userName(subject);
  return `## What to note
Most conversations contain nothing worth keeping. An empty list of notes is the normal answer.

Note a fact only when all of these hold:
- the user stated or confirmed it (not something only Friday said);
- it will still be true in a month;
- it is about the user's or the household's world: people, places, projects, hobbies, belongings, pets, standing preferences, routines.

Never note:
- what is true only inside the conversation (what was just played, asked, or set);
- anything that can be looked up live (weather, times, library contents, device states);
- moods, one-off wishes or small talk;
- a fact a page in the memory already holds, including a note already there;
- anything marked "deliberately forgotten";
- facts that were already remembered in this conversation (shown as "already remembered").

Transcribed speech is noisy. Skip names you can't place, and never "correct" a name into an existing page without clear evidence.
A device or account name (for example "kitchen") is where the user spoke, not a person.
Note a fact on the entity it is about:
- facts about the speaker go on the user's own page (entity "me"), unless the speaker says who they are; this
  includes how they like Friday to behave ("from now on, call me Ray");
- facts about a named other person, place, project, organisation, hobby, belonging or pet go on that entity, also
  when the user says them in the first person ("my sister Anouk works at…" goes on "Anouk", "my Honda needs new
  tyres" on the Honda's page); include the relation to the user in the fact, written as
  "${possessive(user)} sister; works at the library.";
- facts about the household as a whole go on the household's home page (for example "Home").
Only entries under [new] may produce notes; [earlier] entries are context.`;
}

export const PAGE_WRITING = `## Writing pages
- State each fact once, in plain sentences or short lists, in the user's wording where possible.
- The newer fact wins: when a dated note or newer statement contradicts older text, keep the newer one.
- Phrase inferences as tendencies ("usually", "tends to"), never as certainties.
- Never invent facts, dates or relations that the memory or the conversation doesn't state.
- Pages are about one person, place, project, hobby, belonging or topic. Use an existing page name or alias when one fits.`;

export const LINKING = `## Links
- Write other pages' names exactly as the page has them (its name or an alias): mentions of existing pages are
  linked automatically, and you may link one yourself with [[Name]].
- Don't link to the profile. Hub pages such as "Family" are ordinary pages.
- Only link relationships the text already states.`;

/** What gets a page, and what the user's own page holds (hybrid-profile D6). */
export function entities(subject: string): string {
  const user = userName(subject);
  return `## Entities and the user's page
People, places, projects, organisations, hobbies and topics, belongings and pets are entities.
Every entity the memory names gets its own page, also when it knows nothing about it beyond its name and its
relation to the user; a single line is fine ("${possessive(user)} brother.").
A hobby or topic gets a hub page ("Motorcycles", "RC racing"). An item within it (a vehicle, a car, a build) gets a
page of its own once the memory knows more about it than its name and what kind of item it is, and the hub links to it.
"${subject}" is the user's own page: facts about the user themselves (preferences, routines, work, how they like
Friday to behave) and, for each entity, at most a short line with a [[Name]] link to its page ("Wife: [[Lisa]], a
teacher"). Detail about an entity goes on the entity's page; a fact may also be stated in short form on "${subject}".
${user === "the user"
    ? `Write relations to the user as "the user's brother": the user's page has no name yet.`
    : `Write relations to the user with their name: "${possessive(user)} brother", not "the user's brother".`}`;
}

export const SUMMARY = `## The profile summary
The summary is a short overview Friday has at hand in every conversation: who the user is, the household's members
and the user's close relations by name and relation, their home, work, hobbies, belongings and pets by name, and
their standing preferences and routines.
- It is derived from the pages: state only what the pages state, never anything else.
- Name each entity with a [[Name]] link, using the page's exact name or alias. Every link must be to a page that exists.
- Keep it short: plain lines or a short list, within the token budget given. Leave detail out; it is on the pages.`;

const EXTRACTION_ROLE = `You maintain the long-term memory of Friday, a household voice assistant.
Read one finished conversation and list the lasting facts it adds to the memory, as notes.
Each note has an entity (a page name or alias, or "me" for the user), one fact written so it reads on its own,
an optional page type (person, place, project, other) for a new page, and a short reason.`;

function consolidationRole(subject: string): string {
  return `You tidy the long-term memory of Friday, a household voice assistant.
Propose a plan of at most 20 actions over the pages below. Pages marked (changed) changed since the last tidy-up.

Actions:
- rewrite: give a page's full new body (and optionally a new name, aliases or type), based on its revision.
  Fold its "## Notes" into the body (remove the section when empty), dedupe, keep the newer fact, add [[links]].
  Move or copy entity detail from "${subject}" to the entity's page, and keep a short linked line on "${subject}".
- create: a new page, for example for an entity the memory names but has no page for.
- merge: fold page "from" into page "into" when both are about the same thing; give "into"'s full new body.
  "from" is deleted and its names become aliases of "into".

Every rewrite and merge lists in "dropped" each line it deliberately removes (for example a superseded fact),
with a reason. Anything else from the old body must still be stated somewhere in the result.
The profile is generated separately and is not yours to change. Never rename or retype "${subject}", never merge it
into another page, and never use a "deliberately forgotten" name.
An empty plan is a good answer when the pages are already tidy. "note" summarizes the plan in one sentence.`;
}

const SUMMARY_ROLE = `You write the profile summary for the long-term memory of Friday, a household voice assistant.
Read the pages below and answer with the summary's text only.`;

/** The extraction system prompt: the role, the shared guidance, then the rendered memory. */
export function extractionSystem(brain: string, subject: string): string {
  return [EXTRACTION_ROLE, extractionFilter(subject), PAGE_WRITING, LINKING, entities(subject), `## The memory\n${brain}`].join("\n\n");
}

/** The consolidation system prompt: the role and the shared guidance (the pages go in the prompt). */
export function consolidationSystem(subject: string): string {
  return [consolidationRole(subject), PAGE_WRITING, LINKING, entities(subject)].join("\n\n");
}

/** The summary system prompt: the role and the summary guidance (the pages go in the prompt). */
export function summarySystem(subject: string): string {
  return [SUMMARY_ROLE, SUMMARY, LINKING, entities(subject)].join("\n\n");
}
