import { describe, it, expect } from "vitest";
import { matchRoute } from "./router";

describe("matchRoute", () => {
  it("maps / to the overview page", () => {
    expect(matchRoute("/")).toEqual({ page: "overview", params: {} });
  });

  it("maps /repos to the repos page", () => {
    expect(matchRoute("/repos")).toEqual({ page: "repos", params: {} });
    // a trailing slash is tolerated (empty segments are dropped)
    expect(matchRoute("/repos/")).toEqual({ page: "repos", params: {} });
  });

  it("maps /repos/:owner/:name to the repoPulls page", () => {
    expect(matchRoute("/repos/acme/widgets")).toEqual({
      page: "repoPulls",
      params: { owner: "acme", name: "widgets" },
    });
  });

  it("decodes URL-encoded segments, so an encoded slash stays inside one segment", () => {
    expect(matchRoute("/repos/o/n%2Fx")).toEqual({
      page: "repoPulls",
      params: { owner: "o", name: "n/x" },
    });
  });

  it("maps /repos/:owner/:name/pulls/:number to the pullDetail page with a numeric number", () => {
    expect(matchRoute("/repos/acme/widgets/pulls/7")).toEqual({
      page: "pullDetail",
      params: { owner: "acme", name: "widgets", number: 7 },
    });
  });

  it("decodes owner/name on the pullDetail route too", () => {
    expect(matchRoute("/repos/my-org/n%2Fx/pulls/42")).toEqual({
      page: "pullDetail",
      params: { owner: "my-org", name: "n/x", number: 42 },
    });
  });

  it("falls back to overview for unmatched paths", () => {
    expect(matchRoute("/nope")).toEqual({ page: "overview", params: {} });
    expect(matchRoute("/repos/a/b/c")).toEqual({ page: "overview", params: {} });
    expect(matchRoute("/repos/a/b/tags/1")).toEqual({ page: "overview", params: {} });
  });

  it("falls back to overview when the pull number is not numeric", () => {
    expect(matchRoute("/repos/a/b/pulls/abc")).toEqual({ page: "overview", params: {} });
  });

  it("falls back to overview for a malformed percent-escape without throwing", () => {
    // decodeURIComponent would throw a URIError on these; matchRoute must stay total so a bad
    // deep link degrades to the overview page instead of white-screening the SPA.
    expect(() => matchRoute("/repos/a/%")).not.toThrow();
    expect(matchRoute("/repos/a/%")).toEqual({ page: "overview", params: {} });

    expect(() => matchRoute("/repos/a/%E0%A4")).not.toThrow();
    expect(matchRoute("/repos/a/%E0%A4")).toEqual({ page: "overview", params: {} });

    // Also on the pull-detail shape, where the number segment is otherwise valid.
    expect(() => matchRoute("/repos/a/%/pulls/1")).not.toThrow();
    expect(matchRoute("/repos/a/%/pulls/1")).toEqual({ page: "overview", params: {} });
  });
});
