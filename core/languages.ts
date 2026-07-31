export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
  haskell: [".hs", ".lhs"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  scala: [".scala", ".sc"],
  "c-cpp": [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  solidity: [".sol"],
};
export const LANGUAGE_NAMES = Object.keys(LANGUAGE_EXTENSIONS);
const EXT_TO_LANG: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([lang, exts]) => exts.map((e) => [e, lang])),
);
export function detectLanguages(files: string[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot < 0) continue;
    const lang = EXT_TO_LANG[f.slice(dot).toLowerCase()];
    if (lang) found.add(lang);
  }
  return [...found].sort();
}
