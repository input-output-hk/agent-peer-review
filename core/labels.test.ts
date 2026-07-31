import { describe, it, expect } from "vitest";
import { composeRequestLabels, parseSkills, buildProfile, TRIGGER } from "./labels.js";

describe("labels", () => {
  it("composes agent + bare skill labels", () => {
    expect(composeRequestLabels(["security", "react-native"])).toEqual(["agent", "security", "react-native"]);
  });
  it("parses only known skill names, ignoring other labels", () => {
    expect(parseSkills(["agent", "security", "bug", "documentation", "wontfix"]))
      .toEqual(["security", "documentation"]);
  });
  it("builds a profile of agent + all skills by default", () => {
    const names = buildProfile().map((l) => l.name);
    expect(names[0]).toBe(TRIGGER);
    expect(names).toEqual(expect.arrayContaining(["agent", "security", "react-native", "oid4vc"]));
    expect(names).not.toContain("review");
    expect(names).not.toContain("reviewer:yurii");
    expect(names).not.toContain("rust");
  });
});
