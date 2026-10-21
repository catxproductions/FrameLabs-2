/* Off-main-thread CPU kernels for FrameLab.
   Handles both the optional utilization report and live body integration. */
'use strict';

const BODY_STRIDE = 13;

function integrateBodies(buffer, dt) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength % (BODY_STRIDE * Float32Array.BYTES_PER_ELEMENT) !== 0) {
    throw new Error('Invalid packed body state sent to CPU physics worker.');
  }
  const data = new Float32Array(buffer);
  const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
  for (let i = 0; i < data.length / BODY_STRIDE; i++) {
    const b = i * BODY_STRIDE;
    const maxVX = Math.max(0, Number(data[b + 10]) || 0);
    const maxVY = Math.max(0, Number(data[b + 11]) || 0);
    const maxOmega = Math.max(0, Number(data[b + 12]) || 0);
    const vx = Math.max(-maxVX, Math.min(maxVX, (Number(data[b + 2]) || 0) + (Number(data[b + 4]) || 0) * step));
    const vy = Math.max(-maxVY, Math.min(maxVY, (Number(data[b + 3]) || 0) + (Number(data[b + 5]) || 0) * step));
    const damping = Math.max(0, Math.min(1, Number(data[b + 9]) || 0));
    const omegaStep = Math.max(-maxOmega, Math.min(maxOmega, (Number(data[b + 7]) || 0) + (Number(data[b + 8]) || 0) * step));
    const omega = omegaStep * damping;
    data[b + 2] = vx;
    data[b + 3] = vy;
    data[b] += vx * step;
    data[b + 1] += vy * step;
    data[b + 7] = omega;
    data[b + 6] += omega * step;
  }
  return data;
}

self.onmessage = (event) => {
  const payload = event.data || {};
  const { id, demands, capacities } = payload;
  if (!Number.isInteger(id)) {
    self.postMessage({ id, error: 'Invalid compute request ID.' });
    return;
  }

  if (payload.type === 'integrateBodies') {
    try {
      const data = integrateBodies(payload.data, payload.dt);
      self.postMessage({ id, type: 'integrateBodies', backend: 'CPU worker physics', data: data.buffer }, [data.buffer]);
    } catch (error) {
      self.postMessage({ id, error: error?.message || 'CPU physics integration failed.' });
    }
    return;
  }

  if (payload.type === 'projectConstraints') {
    try {
      if (!(payload.nodes instanceof ArrayBuffer) || !(payload.edges instanceof ArrayBuffer) ||
          payload.nodes.byteLength % (5 * Float64Array.BYTES_PER_ELEMENT) !== 0 ||
          payload.edges.byteLength % (4 * Float64Array.BYTES_PER_ELEMENT) !== 0) {
        throw new Error('Invalid node/link state sent to CPU constraint worker.');
      }
      const nodes = new Float64Array(payload.nodes), edges = new Float64Array(payload.edges);
      const nodeStride = 5, edgeStride = 4, count = nodes.length / nodeStride;
      const iterations = Math.max(1, Math.min(32, Math.trunc(Number(payload.iterations) || 1)));
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (let e = 0; e < edges.length / edgeStride; e++) {
          const q = e * edgeStride, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
          if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
          const a = ai * nodeStride, b = bi * nodeStride;
          const dx = nodes[b] - nodes[a], dy = nodes[b + 1] - nodes[a + 1], dist = Math.hypot(dx, dy);
          if (dist < 1e-5) continue;
          const wa = Math.max(0, nodes[a + 4]), wb = Math.max(0, nodes[b + 4]), sum = wa + wb;
          if (sum <= 0) continue;
          const gain = Math.max(0, Math.min(1.5, edges[q + 3])), error = (dist - Math.max(0.001, edges[q + 2])) / dist;
          const corrX = dx * error * gain, corrY = dy * error * gain;
          nodes[a] += corrX * wa / sum; nodes[a + 1] += corrY * wa / sum;
          nodes[b] -= corrX * wb / sum; nodes[b + 1] -= corrY * wb / sum;
        }
      }
      for (let e = 0; e < edges.length / edgeStride; e++) {
        const q = e * edgeStride, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
        if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
        const a = ai * nodeStride, b = bi * nodeStride;
        const dx = nodes[b] - nodes[a], dy = nodes[b + 1] - nodes[a + 1], dist = Math.hypot(dx, dy);
        if (dist < 1e-5) continue;
        const nx = dx / dist, ny = dy / dist, gain = Math.max(0, Math.min(1.5, edges[q + 3]));
        const rel = ((nodes[b + 2] - nodes[a + 2]) * nx + (nodes[b + 3] - nodes[a + 3]) * ny) * gain;
        if (Math.abs(rel) < 1e-5) continue;
        const wa = Math.max(0, nodes[a + 4]), wb = Math.max(0, nodes[b + 4]), sum = wa + wb;
        if (sum <= 0) continue;
        nodes[a + 2] += nx * rel * wa / sum; nodes[a + 3] += ny * rel * wa / sum;
        nodes[b + 2] -= nx * rel * wb / sum; nodes[b + 3] -= ny * rel * wb / sum;
      }
      self.postMessage({ id, type: 'projectConstraints', backend: 'CPU worker constraints', data: nodes.buffer }, [nodes.buffer]);
    } catch (error) {
      self.postMessage({ id, error: error?.message || 'CPU constraint projection failed.' });
    }
    return;
  }

  if (!demands || !capacities || typeof demands.length !== 'number' || demands.length !== capacities.length) {
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
