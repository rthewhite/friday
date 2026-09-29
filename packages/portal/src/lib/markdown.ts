/**
 * Markdown for model output. Model text is untrusted (a tool may have fetched a page written to
 * steer it), so raw HTML is off and shows as text; markdown-it also refuses javascript:, vbscript:,
 * file: and non-image data: links. Links open in a new tab without access to the portal window.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const renderLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return renderLink(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}
