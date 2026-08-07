/**
 * A tiny hand-rolled client router. No routing library: the whole app is a single
 * static bundle that the server serves for every non-API path (SPA history fallback),
 * so routing is just a matter of reading `window.location.pathname` and mapping it to a
 * page. `matchRoute` is a pure function so it can be unit-tested without a DOM.
 */
import { useEffect, useState } from "react";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

export type Route =
  | { page: "overview"; params: Record<string, never> }
  | { page: "repos"; params: Record<string, never> }
  | { page: "repoPulls"; params: { owner: string; name: string } }
  | { page: "pullDetail"; params: { owner: string; name: string; number: number } };

/**
 * `decodeURIComponent` that never throws. A malformed percent-escape (e.g. a lone `%` or a
 * truncated UTF-8 sequence like `%E0%A4`) would otherwise throw a `URIError` mid-render and
 * white-screen the whole SPA; here it returns `null` instead so `matchRoute` can treat the
 * segment as unmatched and fall back to the overview page.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Pure, total pathname parser. Maps `/`, `/repos`, `/repos/:owner/:name`, and
 * `/repos/:owner/:name/pulls/:number` to a `{ page, params }` descriptor,
 * `decodeURIComponent`-ing each path segment (so an encoded slash like `%2F` survives as
 * part of a single owner/name segment). Anything that does not match falls back to the
 * overview page: an unknown path, a non-numeric pull number, or a segment whose
 * percent-encoding is malformed (which never throws, see `safeDecode`).
 */
export function matchRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { page: "overview", params: {} };
  }

  if (segments[0] === "repos") {
    if (segments.length === 1) {
      return { page: "repos", params: {} };
    }
    if (segments.length === 3) {
      const owner = safeDecode(segments[1]!);
      const name = safeDecode(segments[2]!);
      if (owner !== null && name !== null) {
        return { page: "repoPulls", params: { owner, name } };
      }
    }
    if (segments.length === 5 && segments[3] === "pulls" && /^\d+$/.test(segments[4]!)) {
      const owner = safeDecode(segments[1]!);
      const name = safeDecode(segments[2]!);
      if (owner !== null && name !== null) {
        return { page: "pullDetail", params: { owner, name, number: Number(segments[4]) } };
      }
    }
  }

  return { page: "overview", params: {} };
}

/**
 * Push `path` onto the history stack and notify subscribers. `history.pushState` does not
 * itself emit `popstate`, so we dispatch one manually; every `useRoute` consumer listens
 * for it and re-renders with the new pathname.
 */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Subscribe to the current route. Tracks `window.location.pathname` via a `popstate` listener. */
export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return matchRoute(pathname);
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

/**
 * An `<a href>` that navigates client-side on a plain left click. Modified clicks
 * (cmd/ctrl/shift/alt) and non-left buttons fall through to the browser's default so
 * "open in new tab" and friends keep working, as does any consumer-supplied `onClick`.
 */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (onClick) onClick(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Let the browser handle a link aimed at another target (e.g. target="_blank").
    if (rest.target && rest.target !== "_self") return;
    event.preventDefault();
    navigate(to);
  }

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
