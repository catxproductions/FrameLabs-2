/* Off-main-thread CPU kernels for FrameLab.
   Handles both the optional utilization report and live body integration. */
'use strict';

const BODY_STRIDE = 13;

let wasmLoadPromise = null;

// Initialize while idle. Failed fetches leave the JavaScript worker kernels active.
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
          !api.project_constraints || !api.integrate_bodies || !api.resolve_debris_pairs) {
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
      const cx = dx * error * gain, cy = dy * error * gain;
      nodes[a] += cx * wa / sum; nodes[a + 1] += cy * wa / sum;
      nodes[b] -= cx * wb / sum; nodes[b + 1] -= cy * wb / sum;
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


function runWasmDebrisPairs(api, bodyBuffer, pairBuffer, moisture) {
  const stride = 17;
  if (!api || !(bodyBuffer instanceof ArrayBuffer) || !(pairBuffer instanceof ArrayBuffer) ||
      bodyBuffer.byteLength % (stride * Float64Array.BYTES_PER_ELEMENT) !== 0 ||
      pairBuffer.byteLength % (2 * Uint32Array.BYTES_PER_ELEMENT) !== 0) return null;
  const bodyCount = bodyBuffer.byteLength / (stride * Float64Array.BYTES_PER_ELEMENT);
  const pairCount = pairBuffer.byteLength / (2 * Uint32Array.BYTES_PER_ELEMENT);
  if (!bodyCount || !pairCount) return null;
  try {
    api.reset_alloc();
    const bodiesPtr = api.alloc(bodyBuffer.byteLength);
    const pairsPtr = api.alloc(pairBuffer.byteLength);
    const eventsBytes = pairCount * 4 * Float64Array.BYTES_PER_ELEMENT;
    const eventsPtr = api.alloc(eventsBytes);
    if (!bodiesPtr || !pairsPtr || !eventsPtr) return null;
    new Float64Array(api.memory.buffer, bodiesPtr, bodyBuffer.byteLength / 8).set(new Float64Array(bodyBuffer));
    new Uint32Array(api.memory.buffer, pairsPtr, pairBuffer.byteLength / 4).set(new Uint32Array(pairBuffer));
    if (api.resolve_debris_pairs(bodiesPtr, pairsPtr, eventsPtr, bodyCount, pairCount, Number(moisture) || 0) !== 0) return null;
    const bodies = new Float64Array(bodyBuffer.byteLength / 8);
    const events = new Float64Array(pairCount * 4);
    bodies.set(new Float64Array(api.memory.buffer, bodiesPtr, bodies.length));
    events.set(new Float64Array(api.memory.buffer, eventsPtr, events.length));
    return { bodies, events };
  } catch (_) {
    return null;
  } finally {
    api.reset_alloc();
  }
}

function handlePhysicsRequest(payload, api) {
  const { id } = payload;
  if (payload.type === 'resolveDebrisPairs') {
    try {
      const result = runWasmDebrisPairs(api, payload.bodies, payload.pairs, payload.moisture);
      if (!result) {
        self.postMessage({ id, type: 'resolveDebrisPairs', backend: 'JavaScript fallback required' });
        return;
      }
      self.postMessage({
        id, type: 'resolveDebrisPairs',
        backend: 'C++ WebAssembly · debris collision solver',
        bodies: result.bodies.buffer, events: result.events.buffer
      }, [result.bodies.buffer, result.events.buffer]);
    } catch (error) {
      self.postMessage({ id, type: 'resolveDebrisPairs', backend: 'JavaScript fallback required', error: error?.message });
    }
    return;
  }
  if (payload.type === 'integrateBodies') {
    try {
      const wasmData = runWasmIntegration(api, payload.data, payload.dt);
      const data = wasmData || integrateBodies(payload.data, payload.dt);
      self.postMessage({
        id, type: 'integrateBodies',
        backend: wasmData ? 'C++ WebAssembly · CPU worker physics' : 'CPU worker physics',
        data: data.buffer
      }, [data.buffer]);
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
      const iterations = Math.max(1, Math.min(32, Math.trunc(Number(payload.iterations) || 1)));
      const wasmData = runWasmConstraints(api, nodes, edges, iterations);
      const data = wasmData || projectConstraintsJS(nodes, edges, iterations);
      self.postMessage({
        id, type: 'projectConstraints',
        backend: wasmData ? 'C++ WebAssembly · CPU worker constraints' : 'CPU worker constraints',
        data: data.buffer
      }, [data.buffer]);
    } catch (error) {
      self.postMessage({ id, error: error?.message || 'CPU constraint projection failed.' });
    }
  }
}


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

  if (payload.type === 'integrateBodies' || payload.type === 'projectConstraints' || payload.type === 'resolveDebrisPairs') {
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
