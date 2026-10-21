/* CPU worker for FrameLab's supplemental numeric diagnostic only. */
'use strict';
self.onmessage = (event) => {
  const payload = event.data || {};
  const { id, demands, capacities } = payload;
  if (!Number.isInteger(id) || !demands || !capacities ||
      typeof demands.length !== 'number' || demands.length !== capacities.length) {
    self.postMessage({ id, error: 'Invalid demand/capacity arrays sent to compute worker.' });
    return;
  }

  let maxUtil = 0, sumUtil = 0, overloaded = 0;
  const count = demands.length;
  for (let i = 0; i < count; i++) {
    const rawDemand = Number(demands[i]);
    const rawCapacity = Number(capacities[i]);
    const demand = Number.isFinite(rawDemand) ? Math.max(0, rawDemand) : 0;
    const capacity = Number.isFinite(rawCapacity) ? Math.max(0.01, rawCapacity) : 0.01;
    const util = demand / capacity;
    if (util > maxUtil) maxUtil = util;
    if (util >= 1) overloaded++;
    sumUtil += util;
  }
  self.postMessage({
    id,
    backend: 'Web Worker (CPU)',
    count,
    maxUtil,
    meanUtil: count ? sumUtil / count : 0,
    overloaded
  });
};
