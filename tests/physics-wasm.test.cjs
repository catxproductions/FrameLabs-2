'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wasmBytes = fs.readFileSync(path.resolve(__dirname, '../js/physics-core.wasm'));

async function loadKernel() {
  assert.equal(WebAssembly.validate(wasmBytes), true, 'C++ module must be valid WebAssembly');
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  assert.equal(instance.exports.abi_version(), 1, 'worker ABI version matches');
  return instance.exports;
}

function solveWasm(api, nodes, edges, iterations) {
  api.reset_alloc();
  try {
    const nodesPtr = api.alloc(nodes.byteLength);
    const edgesPtr = api.alloc(edges.byteLength);
    assert.ok(nodesPtr > 0 && edgesPtr > 0, 'allocations should succeed');
    new Float64Array(api.memory.buffer, nodesPtr, nodes.length).set(nodes);
    new Float64Array(api.memory.buffer, edgesPtr, edges.length).set(edges);
    assert.equal(api.project_constraints(nodesPtr, edgesPtr, nodes.length / 5, edges.length / 4, iterations), 0);
    const result = new Float64Array(nodes.length);
    result.set(new Float64Array(api.memory.buffer, nodesPtr, nodes.length));
    return result;
  } finally {
    api.reset_alloc();
  }
}

function solveJs(nodes, edges, iterations) {
  const count = nodes.length / 5;
  for (let iteration = 0; iteration < Math.max(1, Math.min(32, Math.trunc(iterations || 1))); iteration++) {
    for (let e = 0; e < edges.length / 4; e++) {
      const q = 4 * e, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
      if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
      const a = 5 * ai, b = 5 * bi;
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
    const q = 4 * e, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
    if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
    const a = 5 * ai, b = 5 * bi;
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

test('WebAssembly ABI and linear-memory allocator are valid', async () => {
  const api = await loadKernel();
  api.reset_alloc();
  try {
    const ptr = api.alloc(3 * 1024 * 1024);
    assert.ok(ptr > 0, 'allocator should grow beyond initial memory');
    assert.ok(api.memory.buffer.byteLength >= ptr + 3 * 1024 * 1024);
  } finally {
    api.reset_alloc();
  }
});

test('C++ constraint solver matches the ordered JavaScript solver', async () => {
  const api = await loadKernel();
  const nodes = new Float64Array([
    0, 0, 0.1, -0.2, 0,
    1.4, 0.2, 2.0, 0.4, 0.75,
    2.5, 1.1, -0.2, 1.0, 0.5,
    2.5, 1.1, 1.0, 1.0, 0.25
  ]);
  const edges = new Float64Array([
    0, 1, 1.0, 1.0, 1, 2, 1.1, 0.8, 2, 3, 0.75, 1.2,
    -1, 0, 1.0, 1.0, 2, 200, 1.0, 1.0
  ]);
  const expected = solveJs(new Float64Array(nodes), new Float64Array(edges), 8);
  const actual = solveWasm(api, new Float64Array(nodes), new Float64Array(edges), 8);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-8, `state[${i}] differs: ${actual[i]} vs ${expected[i]}`);
  }
});

test('C++ body integration matches Float32 JavaScript integration', async () => {
  const api = await loadKernel();
  const source = new Float32Array([
    1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5,
    -2, 0.3, -1.5, 0.1, 0.3, -2, -0.25, -0.5, 1.4, 0.75, 2, 3, 4
  ]);
  const expected = new Float32Array(source), dt = 0.05;
  for (let i = 0; i < expected.length / 13; i++) {
    const b = i * 13;
    const maxVX = Math.max(0, Number(expected[b + 10]) || 0);
    const maxVY = Math.max(0, Number(expected[b + 11]) || 0);
    const maxOmega = Math.max(0, Number(expected[b + 12]) || 0);
    const vx = Math.max(-maxVX, Math.min(maxVX, (Number(expected[b + 2]) || 0) + (Number(expected[b + 4]) || 0) * dt));
    const vy = Math.max(-maxVY, Math.min(maxVY, (Number(expected[b + 3]) || 0) + (Number(expected[b + 5]) || 0) * dt));
    const damping = Math.max(0, Math.min(1, Number(expected[b + 9]) || 0));
    const omegaStep = Math.max(-maxOmega, Math.min(maxOmega, (Number(expected[b + 7]) || 0) + (Number(expected[b + 8]) || 0) * dt));
    const omega = omegaStep * damping;
    expected[b + 2] = vx; expected[b + 3] = vy;
    expected[b] += vx * dt; expected[b + 1] += vy * dt;
    expected[b + 7] = omega; expected[b + 6] += omega * dt;
  }
  api.reset_alloc();
  try {
    const ptr = api.alloc(source.byteLength);
    assert.ok(ptr > 0);
    new Float32Array(api.memory.buffer, ptr, source.length).set(source);
    assert.equal(api.integrate_bodies(ptr, source.length / 13, dt), 0);
    const actual = new Float32Array(source.length);
    actual.set(new Float32Array(api.memory.buffer, ptr, source.length));
    assert.deepEqual(Array.from(actual), Array.from(expected));
  } finally {
    api.reset_alloc();
  }
});


test('C++ debris collision solver separates overlapping bodies and reports impact energy', async () => {
  const api = await loadKernel();
  assert.equal(typeof api.resolve_debris_pairs, 'function');
  const stride = 19;
  const a = [0, 0, 1, 0, 0, 0, 2, 1, 1, 0, 10, 1, 0, 0.6, 0.35, 0.12, 0.2, 1, 0];
  const b = [1.5, 0, -1, 0, 0, 0, 2, 1, 1, 0, 10, 1, 0, 0.7, 0.30, 0.16, 0.15, 1, 0];
  const bodies = new Float64Array([...a, ...b]);
  assert.equal(bodies.length, stride * 2);
  const pairs = new Uint32Array([0, 1]);
  api.reset_alloc();
  try {
    const bodiesPtr = api.alloc(bodies.byteLength);
    const pairsPtr = api.alloc(pairs.byteLength);
    const eventsPtr = api.alloc(4 * Float64Array.BYTES_PER_ELEMENT);
    assert.ok(bodiesPtr && pairsPtr && eventsPtr);
    new Float64Array(api.memory.buffer, bodiesPtr, bodies.length).set(bodies);
    new Uint32Array(api.memory.buffer, pairsPtr, pairs.length).set(pairs);
    assert.equal(api.resolve_debris_pairs(bodiesPtr, pairsPtr, eventsPtr, 2, 1, 0), 0);
    const solved = new Float64Array(bodies.length);
    solved.set(new Float64Array(api.memory.buffer, bodiesPtr, bodies.length));
    const events = new Float64Array(4);
    events.set(new Float64Array(api.memory.buffer, eventsPtr, 4));
    assert.equal(events[0], 1);
    assert.ok(events[1] > 0);
    assert.ok(events[2] > 0);
    assert.ok(events[3] > 0);
    assert.ok(solved[0] < 0);
    assert.ok(solved[stride] > 1.5);
    assert.ok(Number.isFinite(solved[2]) && Number.isFinite(solved[stride + 2]));
  } finally {
    api.reset_alloc();
  }
});
