// Limits that keep a simulated command from freezing the page. A real system would run a ping for hours
// or print a gigabyte of padding; the simulator stops early and says so, instead of locking up the tab.

/** Most ping / Test-Connection replies shown for one command. */
export const MAX_REPLIES = 100;

/** Largest printf field width or precision the simulator builds. */
export const MAX_FORMAT_WIDTH = 10000;

/** The note shown when a ping is cut short. */
export const repliesNote = (count: number, option: string) =>
  `The simulator shows the first ${MAX_REPLIES} replies; a real ${option} ${count} keeps pinging once a second.`;
