/**
 * One change to try on the test site. Each pull request with something to see adds its own file in
 * src/data/testing/ (named after the PR), so two PRs never edit the same file. The #/testing page lists them.
 */
export interface TestNote {
  /** The pull request number */
  pr: number;
  title: string;
  /** Where to go and what to try, in order */
  steps: string[];
  /** Links straight to the places the steps mention */
  links: { label: string; href: string }[];
}
