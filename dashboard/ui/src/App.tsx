/**
 * App shell: a header (app name, nav, theme toggle) over the routed page body. Routing is
 * hand-rolled (see `router.tsx`): `useRoute` + `matchRoute` pick which page to render from
 * `window.location.pathname`, and the server serves this same bundle for every non-API path,
 * so deep links and the browser back/forward buttons all work.
 */
import { useEffect, useState } from "react";
import { useRoute, Link } from "./router";
import { Overview } from "./pages/Overview";
import { Repos } from "./pages/Repos";
import { RepoPulls } from "./pages/RepoPulls";
import { PullDetail } from "./pages/PullDetail";
import { Agents } from "./pages/Agents";
import { Collaborators } from "./pages/Collaborators";

type Theme = "light" | "dark";

/** Prefer an already-set theme, then the OS preference (when available), else light. */
function initialTheme(): Theme {
  const current = document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      style={{
        background: "var(--surface)",
        color: "var(--fg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "0.35rem 0.75rem",
        font: "inherit",
        cursor: "pointer",
      }}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

function CurrentPage() {
  const route = useRoute();
  switch (route.page) {
    case "overview":
      return <Overview />;
    case "repos":
      return <Repos />;
    case "agents":
      return <Agents />;
    case "collaborators":
      return <Collaborators />;
    case "repoPulls":
      return <RepoPulls owner={route.params.owner} name={route.params.name} />;
    case "pullDetail":
      return <PullDetail owner={route.params.owner} name={route.params.name} number={route.params.number} />;
  }
}

export function App() {
  return (
    <main style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>
          <Link to="/" style={{ color: "inherit", textDecoration: "none" }}>
            Agent Peer Review Dashboard
          </Link>
        </h1>
        <nav style={{ display: "flex", gap: "1rem", marginLeft: "auto" }}>
          <Link to="/">Overview</Link>
          <Link to="/repos">Repositories</Link>
          <Link to="/agents">Agents</Link>
          <Link to="/collaborators">Collaborators</Link>
        </nav>
        <ThemeToggle />
      </header>
      <CurrentPage />
    </main>
  );
}
