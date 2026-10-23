/**
 * True on the private test site: terminus-wm builds with VITE_TEST_SITE=1 (set by the test-site workflow).
 * The #/testing page and the strip that links to it exist only there; the live site never shows them.
 */
export const TEST_SITE = (import.meta.env?.VITE_TEST_SITE ?? '') === '1';
