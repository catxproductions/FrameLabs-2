/* Off-main-thread CPU kernels for FrameLab.
   Handles both the optional utilization report and live body integration. */
'use strict';

const BODY_STRIDE = 13;

let wasmLoadPromise = null;

// Initialize while idle. Failed fetches leave the existing JavaScript kernels active.
if (typeof fetch === 'function' && typeof WebAssembly === 'object') {
  wasmLoadPromise = (async () => {
    try {
      const assetURL = self.location && typeof URL === 'function'
        ? new URL('./physics-core.wasm', self.location.href).href
        : './physics-core.wasm';
      const response = await fetch(assetURL);
      if (!response.ok) throw new Error(`HTTP ${response.status} loading physics-core.wasm`);
      const loaded = await WebAssembly.instantiate(await response.arrayBuffer());
      const api = loaded.instance.exports;
      if (api.abi_version() !== 1 || !api.memory || !api.alloc || !api.reset_alloc ||
          !api.project_constraints || !api.integrate_bodies) {
        throw new Error('Unsupported physics-core WebAssembly ABI');
      }
      return api;
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('FrameLabs: C++ WebAssembly unavailable; using JavaScript worker kernels.', error);
      }
      return null;
    }
  })();
}

function runWasmIntegration(api, buffer, dt) {
  if (!api || !(buffer instanceof ArrayBuffer)) return null;
  const source = new Float32Array(buffer);
  if (!source.length || source.length % BODY_STRIDE !== 0) return null;
  try {
    api.reset_alloc();
    const ptr = api.alloc(source.byteLength);
    if (!ptr) return null;
    new Float32Array(api.memory.buffer, ptr, source.length).set(source);
    if (api.integrate_bodies(ptr, source.length / BODY_STRIDE, Number(dt)) !== 0) return null;
    const result = new Float32Array(source.length);
    result.set(new Float32Array(api.memory.buffer, ptr, source.length));
    return result;
  } catch (_) {
    return null;
  } finally {
    api.reset_alloc();
  }
}

function projectConstraintsJS(nodes, edges, iterations) {
  const stride = 5, count = nodes.length / stride;
  const loops = Math.max(1, Math.min(32, Math.trunc(Number(iterations) || 1)));
  for (let iteration = 0; iteration < loops; iteration++) {
    for (let e = 0; e < edges.length / 4; e++) {
      const q = e * 4, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
      if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
      const a = ai * stride, b = bi * stride;
      const dx = nodes[b] - nodes[a], dy = nodes[b + 1] - nodes[a + 1], dist = Math.hypot(dx, dy);
      if (dist < 1e-5) continue;
      const wa = Math.max(0, nodes[a + 4]), wb = Math.max(0, nodes[b + 4]), sum = wa + wb;
      if (sum <= 0) continue;
      const gain = Math.max(0, Math.min(1.5, edges[q + 3]));
      const error = (dist - Math.max(0.001, edges[q + 2])) / dist;
      const corrX = dx * error * gain, corrY = dy * error * gain;
      nodes[a] += corrX * wa / sum; nodes[a + 1] += corrY * wa / sum;
      nodes[b] -= corrX * wb / sum; nodes[b + 1] -= corrY * wb / sum;
    }
  }
  for (let e = 0; e < edges.length / 4; e++) {
    const q = e * 4, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
    if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
    const a = ai * stride, b = bi * stride;
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
  return nodes;
}

function runWasmConstraints(api, nodes, edges, iterations) {
  if (!api || !nodes.length || !edges.length) return null;
  try {
    api.reset_alloc();
    const nodesPtr = api.alloc(nodes.byteLength);
    const edgesPtr = api.alloc(edges.byteLength);
    if (!nodesPtr || !edgesPtr) return null;
    // Create views only after both allocations because an allocation may grow Wasm memory.
    new Float64Array(api.memory.buffer, nodesPtr, nodes.length).set(nodes);
    new Float64Array(api.memory.buffer, edgesPtr, edges.length).set(edges);
    if (api.project_constraints(nodesPtr, edgesPtr, nodes.length / 5, edges.length / 4, Number(iterations) || 1) !== 0) return null;
    const result = new Float64Array(nodes.length);
    result.set(new Float64Array(api.memory.buffer, nodesPtr, nodes.length));
    return result;
  } catch (_) {
    return null;
  } finally {
    api.reset_alloc();
  }
}

function handlePhysicsRequest(payload, api) {
  const { id } = payload;
  if (payload.type === 'integrateBodies' || payload.type === 'projectConstraints') {
    const execute = (api) => handlePhysicsRequest(payload, api);
    if (wasmLoadPromise) wasmLoadPromise.then(execute).catch(() => execute(null));
    else execute(null);
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
