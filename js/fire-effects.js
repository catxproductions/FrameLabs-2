/* Bounded visual helpers for large fires. Simulation logic is not capped here. */
(() => {
  "use strict";

  function sampleIndices(total, budget, offset = 0) {
    const count = Math.max(0, Math.floor(Number(total) || 0));
    const limit = Math.min(count, Math.max(0, Math.floor(Number(budget) || 0)));
    if (count === 0 || limit === 0) return [];

    const start = ((Math.floor(Number(offset) || 0) % count) + count) % count;
    const indices = new Array(limit);
    for (let i = 0; i < limit; i++) {
      indices[i] = (start + Math.floor(i * count / limit)) % count;
    }
    return indices;
  }

  // Swap-and-pop is constant time. The cursor rotates so particles throughout
  // the visual pool are retired instead of repeatedly favoring one end.
  function evictAtCursor(items, cursor = 0) {
    if (!Array.isArray(items) || items.length === 0) return 0;
    const index = ((Math.floor(Number(cursor) || 0) % items.length) + items.length) % items.length;
    const last = items.length - 1;
    if (index !== last) items[index] = items[last];
    items.pop();
    return items.length ? index % items.length : 0;
  }

  window.FrameLabFireEffects = Object.freeze({ sampleIndices, evictAtCursor });
})();
