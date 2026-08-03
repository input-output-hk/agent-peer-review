import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: ["intro", "quick-start", "lifecycle", "labels", "languages", "skills", "cli", "mcp", "pi", "schemas", "contributing-a-skill", { type: "category", label: "Architecture Decisions", items: ["adr/index", "adr/github-as-the-source-of-truth", "adr/labels-and-native-reviewer-routing", "adr/core-library-with-thin-adapters", "adr/panel-review-concurrent-reviewers", "adr/review-context-loading", "adr/pi-dev-integration-as-a-pi-package", "adr/untrusted-input-defense"] }],
};
export default sidebars;
