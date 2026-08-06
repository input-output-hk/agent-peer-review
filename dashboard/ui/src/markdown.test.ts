import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("runs in a DOM environment so DOMPurify can sanitize", () => {
    // DOMPurify auto-detects the global `window`; this test file must run under the
    // jsdom vitest environment (see vitest.config.ts's `ui/**` environmentMatchGlobs)
    // or every other test below would throw at import/sanitize time, not just fail.
    expect(typeof window).not.toBe("undefined");
  });

  it("neutralizes an embedded <script> tag", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
  });

  it("neutralizes a javascript: scheme link (no anchor is produced at all)", () => {
    // markdown-it's own built-in validateLink() already refuses vbscript:/javascript:/
    // file:/non-image-data: schemes before the link rule fires, so this input falls
    // back to literal escaped text rather than becoming an <a href="javascript:...">.
    // The literal substring "javascript:" therefore survives as inert prose text (not
    // inside any attribute a browser would act on) - the assertion that matters is that
    // no anchor/href was created for it, not that the raw word never appears anywhere.
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/href\s*=\s*"[^"]*javascript:/i);
  });

  it("strips a scheme markdown-it itself does not blacklist but our allowlist rejects", () => {
    // markdown-it's own validator only blacklists vbscript:/javascript:/file:/data:, so
    // it happily emits <a href="ftp://..."> here. This is the case that actually
    // exercises our ALLOWED_URI_REGEXP config (defense-in-depth): DOMPurify strips the
    // href attribute because "ftp" is not in the http(s)/mailto allowlist.
    const html = renderMarkdown("[x](ftp://evil.example/payload)");
    expect(html).not.toContain("ftp:");
    expect(html).not.toMatch(/<a\b[^>]*\shref/i);
  });

  it("forbids <img> tags so a review body can never trigger a remote image load", () => {
    const html = renderMarkdown("![a](http://evil/x.png)");
    expect(html).not.toContain("<img");
  });

  it("forbids <style> tags", () => {
    const html = renderMarkdown("<style>body{background:url(http://evil/x)}</style>");
    expect(html).not.toContain("<style");
  });

  it("renders plain markdown as expected", () => {
    const html = renderMarkdown("**bold** and [ok](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it("allows a mailto: link", () => {
    const html = renderMarkdown("[email](mailto:a@example.com)");
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("treats a nullish source as empty instead of throwing", () => {
    expect(() => renderMarkdown(null as unknown as string)).not.toThrow();
    expect(renderMarkdown(null as unknown as string)).toBe("");
    expect(renderMarkdown(undefined as unknown as string)).toBe("");
  });
});
