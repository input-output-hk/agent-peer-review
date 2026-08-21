import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: ["intro", "quick-start", "files-and-directories", "lifecycle", "review-convergence", "how-it-works", "labels", "languages", "skills", "cli", "mcp", "pi", "taskflows", "metadata-capture", "dashboard", "schemas", "contributing-a-skill", "releasing", { type: "category", label: "Architecture Decisions", items: ["adr/index", "adr/github-as-the-source-of-truth", "adr/labels-and-native-reviewer-routing", "adr/core-library-with-thin-adapters", "adr/panel-review-concurrent-reviewers", "adr/review-context-loading", "adr/pi-dev-integration-as-a-pi-package", "adr/untrusted-input-defense"] }],
};
export default sidebars;
