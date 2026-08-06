/**
 * Renders untrusted markdown (PR review summaries, note bodies) to sanitized HTML.
 *
 * The source is attacker-influenced: it comes from review text posted on GitHub by
 * whichever agent or human authored the PR/review. Two layers of defense:
 *   1. `html: false` on the markdown-it instance means any raw HTML embedded in the
 *      source is escaped as literal text, not parsed into elements.
 *   2. DOMPurify then sanitizes the rendered output as defense-in-depth (catches
 *      markdown-syntax-driven vectors like a `javascript:` link or an `<img>` tag,
 *      which are not raw HTML and so survive step 1).
 * Images are forbidden outright (no remote image loads triggered by rendering a
 * review), and link/href schemes are allowlisted to http(s)/mailto.
 *
 * A React component renders the result via `dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}`.
 */
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({ html: false, linkify: true });

export function renderMarkdown(src: string): string {
  const raw = md.render(src ?? "");
  return DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    FORBID_TAGS: ["img", "style"],
    FORBID_ATTR: ["style"],
  });
}
