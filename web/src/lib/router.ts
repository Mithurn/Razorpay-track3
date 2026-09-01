import { useCallback, useEffect, useState } from "react";

export type Route = { path: string; search: string; params: Record<string, string> };

const listeners = new Set<() => void>();

export function navigate(path: string): void {
  const href = window.location.pathname + window.location.search;
  if (path === href) return;
  window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

function currentHref(): string {
  return window.location.pathname + window.location.search;
}

export function useRoute(): Route {
  const [href, setHref] = useState(currentHref());

  useEffect(() => {
    const update = () => setHref(currentHref());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  const [path, search] = splitHref(href);
  return { path, search, params: {} };
}

function splitHref(href: string): [string, string] {
  const i = href.indexOf("?");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i)];
}

export function match(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.replace(/\/+$/, "").split("/");
  const patternParts = pattern.replace(/\/+$/, "").split("/");
  if (pathParts.length !== patternParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(":")) {
      if (!actual) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function useLink(): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(event.currentTarget.getAttribute("href") ?? "/");
  }, []);
}
