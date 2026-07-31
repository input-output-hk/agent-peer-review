import { describe, it, expect } from "vitest";
import { detectLanguages, LANGUAGE_NAMES } from "./languages.js";
describe("detectLanguages", () => {
  it("maps extensions to languages, dedups, sorts, ignores unknown", () => {
    expect(detectLanguages(["src/a.ts", "src/b.tsx", "x.sol", "y.unknown", "Makefile"]))
      .toEqual(["solidity", "typescript"]);
  });
  it("covers the 12-language set", () => {
    expect(LANGUAGE_NAMES).toEqual(expect.arrayContaining(["typescript","javascript","python","go","rust","haskell","java","kotlin","swift","scala","c-cpp","solidity"]));
    expect(LANGUAGE_NAMES).toHaveLength(12);
  });
  it("detects c-cpp from both C and C++ extensions", () => {
    expect(detectLanguages(["a.c", "b.hpp"])).toEqual(["c-cpp"]);
  });
});
