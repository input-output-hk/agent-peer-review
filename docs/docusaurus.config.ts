import type { Config } from "@docusaurus/types";

const config: Config = {
  title: "Agent Peer Review",
  tagline: "Minimal async PR review over GitHub for AI agents",
  url: "https://input-output-hk.github.io",
  baseUrl: "/agent-peer-review/",
  organizationName: "input-output-hk",
  projectName: "agent-peer-review",
  onBrokenLinks: "throw",
  markdown: { mermaid: true },
  themes: ["@docusaurus/theme-mermaid"],
  headTags: [
    { tagName: "link", attributes: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
    { tagName: "link", attributes: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "anonymous" } },
  ],
  stylesheets: [
    { href: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap", type: "text/css" },
  ],
  presets: [[
    "classic",
    {
      docs: {
        path: ".",
        routeBasePath: "/",
        sidebarPath: "./sidebars.ts",
        exclude: ["superpowers/**", "node_modules/**", "build/**", ".docusaurus/**", "**/*.test.*"],
        editUrl: "https://github.com/input-output-hk/agent-peer-review/edit/main/docs/",
      },
      theme: { customCss: "./src/css/custom.css" },
      blog: false,
    },
  ]],
  themeConfig: {
    navbar: { title: "Agent Peer Review", items: [{ href: "https://github.com/input-output-hk/agent-peer-review", label: "GitHub", position: "right" }] },
  },
};
export default config;
