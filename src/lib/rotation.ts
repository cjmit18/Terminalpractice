/**
 * Rotation for content pools: nothing is capped or retired, only the order changes. Used for the
 * daily challenge order and for the order of checkpoint questions.
 */

/** The list in a random order fixed by `seed` (Fisher-Yates with a mulberry32 generator), the same on every device */
export function shuffled<T>(list: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A fresh seed for an order that should differ from one attempt to the next */
export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 32);

/**
 * A new order for `list` that is not the same as `previous` (when the list has more than one item),
 * so a retry never repeats the order just seen.
 */
export function freshOrder<T>(list: readonly T[], previous: readonly T[] | null, seed: () => number = randomSeed): T[] {
  let order = shuffled(list, seed());
  for (let tries = 0; previous && list.length > 1 && tries < 8 && order.every((x, i) => x === previous[i]); tries++) {
    order = shuffled(list, seed());
  }
  if (previous && list.length > 1 && order.every((x, i) => x === previous[i])) order = [...order.slice(1), order[0]];
  return order;
}
