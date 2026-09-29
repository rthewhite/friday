/**
 * Markdown for brain pages. Bodies may later be written by a model from conversation content, so raw
 * HTML is off and shows as text (as in the portal's chat); markdown-it also refuses javascript:,
 * vbscript:, file: and non-image data: links. `[[Name]]` becomes an internal link when the name
 * resolves, or a dashed "dangling" link that offers to create the page. The page view handles clicks
 * on both by delegation (`data-brain-page` / `data-brain-new`), so no router components are needed
 * inside the rendered HTML.
 */
import MarkdownIt, { type StateInline } from "markdown-it";
import { isLinkTarget } from "../../links.js";

/** Maps a link target (as written) to a page id, or undefined when it is dangling. */
export type Resolve = (target: string) => string | undefined;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const renderLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return renderLink(tokens, idx, options, env, self);
};

/** `[[Name]]`: 1 to 80 characters without brackets or a newline (the same rule as the server). */
function wikilink(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", start + 2);
  if (end === -1) return false;
  const target = src.slice(start + 2, end);
  if (!isLinkTarget(target)) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.content = target.trim();
  }
  state.pos = end + 2;
  return true;
}
md.inline.ruler.before("link", "wikilink", wikilink);

md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
  const name = tokens[idx]!.content;
  const text = md.utils.escapeHtml(name);
  const id = (env as { resolve?: Resolve } | undefined)?.resolve?.(name);
  if (id !== undefined) {
    return `<a href="/m/brain/p/${encodeURIComponent(id)}" class="brain-link" data-brain-page="${md.utils.escapeHtml(id)}">${text}</a>`;
  }
  return `<a href="#" class="brain-link brain-dangling" data-brain-new="${text}" title="No page yet: create it">${text}</a>`;
};

export function renderBody(body: string, resolve: Resolve): string {
  return md.render(body, { resolve });
}
