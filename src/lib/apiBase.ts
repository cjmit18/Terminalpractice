/**
 * The URL the account API paths (`api/...`) resolve against. The API lives next to the app.
 *
 * With an absolute base (VITE_BASE=/, a host that serves the app for any path), resolve against the
 * origin plus that base, not the page: at a deep link such as /old/path the page URL would give
 * /old/api/me, which the Worker does not serve. With a relative base (./, a GitHub Pages project
 * path) the page's own directory is the app's directory, so resolve against the page.
 */
export function apiBase(base: string, origin: string, baseURI: string): string {
  return base.startsWith('/') ? origin + base : baseURI;
}
