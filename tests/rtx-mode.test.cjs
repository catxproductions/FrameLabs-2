'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function makeComputeBackend({ fetchImpl, WorkerImpl } = {}) {
  const status = { textContent: '' };
  const events = [];
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    setTimeout: (fn, delay) => {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    dispatchEvent: (event) => { events.push(event); return true; }
  };
  class CustomEventMock {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    baseURI: 'https://catxproductions.github.io/FrameLabs-2/',
    currentScript: { src: 'https://catxproductions.github.io/FrameLabs-2/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  if (WorkerImpl) window.Worker = WorkerImpl;
  vm.runInNewContext(read('js/compute-backends.js'), {
    window, document, navigator: {}, Worker: WorkerImpl, URL, Float32Array, Float64Array, ArrayBuffer,
    AbortController, CustomEvent: CustomEventMock, fetch: fetchImpl || (async () => { throw new Error('Unexpected fetch'); }),
    queueMicrotask, Math, Number, Map, Promise, Error, RangeError, TypeError, Uint8Array,
    GPUBufferUsage: undefined, GPUMapMode: undefined
  }, { filename: 'compute-backends-rtx.test.js' });
  return { window, status, events, timers };
}

test('RTX Mode is opt-in and routes live body integration through the local CUDA helper', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/health')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          device: 'NVIDIA GeForce RTX 4060 Ti',
          computeCapability: '8.9',
          supports: ['body-integration']
        })
      };
    }
    assert.ok(String(url).endsWith('/integrate'), 'only the documented integration endpoint is used');
    assert.equal(options.method, 'POST');
    assert.equal(options.mode, 'cors');
    assert.equal(options.targetAddressSpace, 'loopback');
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(Number(options.headers['X-FrameLabs-Dt']), 0.05);
    const input = new Float32Array(options.body.buffer, options.body.byteOffset, options.body.byteLength / 4);
    const output = new Float32Array(input);
    for (let i = 0; i < output.length / 13; i++) {
      const b = i * 13, dt = 0.05;
      const maxVX = Math.max(0, output[b + 10]), maxVY = Math.max(0, output[b + 11]);
      const maxOmega = Math.max(0, output[b + 12]);
      const vx = Math.max(-maxVX, Math.min(maxVX, output[b + 2] + output[b + 4] * dt));
      const vy = Math.max(-maxVY, Math.min(maxVY, output[b + 3] + output[b + 5] * dt));
      const omegaStep = Math.max(-maxOmega, Math.min(maxOmega, output[b + 7] + output[b + 8] * dt));
      const omega = omegaStep * Math.max(0, Math.min(1, output[b + 9]));
      output[b + 2] = vx; output[b + 3] = vy;
      output[b] += vx * dt; output[b + 1] += vy * dt;
      output[b + 7] = omega; output[b + 6] += omega * dt;
    }
    return { ok: true, arrayBuffer: async () => output.buffer };
  };
  const env = makeComputeBackend({ fetchImpl });

  assert.equal(env.window.FrameLabCompute.getMode(), 'auto');
  assert.equal(env.window.FrameLabCompute.setMode('rtx'), 'auto',
    'RTX must not activate until a real helper response is validated');
  const connection = await env.window.FrameLabCompute.connectRTX();
  assert.equal(connection.connected, true);
  assert.equal(connection.device, 'NVIDIA GeForce RTX 4060 Ti');
  assert.equal(env.window.FrameLabCompute.setMode('rtx'), 'rtx');

  const body = new Float32Array([1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5]);
  const result = await env.window.FrameLabCompute.integrateBodies(body, 0.05);
  assert.equal(result.backend, 'Native CUDA RTX · NVIDIA GeForce RTX 4060 Ti');
  assert.ok(Math.abs(result.data[0] - 1.055) < 1e-6);
  assert.ok(Math.abs(result.data[1] - 1.925) < 1e-6);
  assert.ok(Math.abs(result.data[6] - 0.5275) < 1e-6);
  assert.equal(requests.length, 2);
  assert.match(env.status.textContent, /Native CUDA RTX/);
  assert.equal(env.window.FrameLabCompute.getDiagnostics().rtxIntegrationCalls, 1);
});

test('RTX bridge loss emits a fallback event and continues through the CPU worker', async () => {
  const events = [];
  const env = makeComputeBackend({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) {
        return {
          ok: true,
          json: async () => ({
            ok: true, device: 'NVIDIA GeForce RTX 4060 Ti',
            computeCapability: '8.9', supports: ['body-integration']
          })
        };
      }
      throw new Error('simulated local helper disconnect');
    },
    WorkerImpl: class WorkerMock {
      constructor() { this.onmessage = null; this.onerror = null; }
      postMessage(message) {
        if (message.type !== 'integrateBodies') throw new Error('Unexpected worker request');
        const data = new Float32Array(message.data);
        const dt = message.dt;
        for (let i = 0; i < data.length / 13; i++) {
          const b = i * 13;
          const vx = Math.max(-data[b + 10], Math.min(data[b + 10], data[b + 2] + data[b + 4] * dt));
          const vy = Math.max(-data[b + 11], Math.min(data[b + 11], data[b + 3] + data[b + 5] * dt));
          const omega = Math.max(-data[b + 12], Math.min(data[b + 12], data[b + 7] + data[b + 8] * dt)) * Math.max(0, Math.min(1, data[b + 9]));
          data[b + 2] = vx; data[b + 3] = vy;
          data[b] += vx * dt; data[b + 1] += vy * dt;
          data[b + 7] = omega; data[b + 6] += omega * dt;
        }
        queueMicrotask(() => this.onmessage?.({
          data: { id: message.id, type: 'integrateBodies', backend: 'CPU worker physics', length: data.length, data: data.buffer }
        }));
      }
      terminate() {}
    }
  });

  const connection = await env.window.FrameLabCompute.connectRTX();
  assert.equal(connection.connected, true);
  env.window.FrameLabCompute.setMode('rtx');
  const body = new Float32Array([1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5]);
  const result = await env.window.FrameLabCompute.integrateBodies(body, 0.05);

  assert.equal(result.backend, 'RTX unavailable · CPU worker physics');
  assert.ok(Math.abs(result.data[0] - 1.055) < 1e-6);
  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].type, 'framelabs:rtx-lost');
  assert.match(env.events[0].detail.reason, /simulated local helper disconnect/);
  assert.equal(env.window.FrameLabCompute.getDiagnostics().rtxFallbacks, 1);
});

test('RTX Mode has a hardware warning, local-only service, and separate Tensor Core benchmark', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const backends = read('js/compute-backends.js');
  const bridge = read('cuda/rtx_bridge.cuh');
  const cuda = read('cuda/tensor_core_mode.cu');
  const cmake = read('cuda/CMakeLists.txt');
  const docs = read('cuda/README.md');

  assert.match(html, /<option value="rtx">RTX Mode · Native CUDA helper<\/option>/);
  assert.match(main, /RTX MODE — HARDWARE WARNING/);
  assert.match(main, /window\.addEventListener\('framelabs:rtx-lost'/);
  assert.match(backends, /const RTX_BRIDGE_URL = 'http:\/\/127\.0\.0\.1:47652'/);
  assert.match(backends, /physicsMode === 'rtx'/);
  assert.match(backends, /connectRTX/);
  assert.match(bridge, /127\.0\.0\.1/);
  assert.match(bridge, /Access-Control-Allow-Origin/);
  assert.match(bridge, /"\/health"/);
  assert.match(bridge, /"\/integrate"/);
  assert.ok(bridge.includes('integrateBodiesKernel<<<(count + 255U) / 256U, 256U>>>'));

  assert.match(cuda, /#include <mma\.h>/);
  assert.match(cuda, /runRTXBridgeServer\(\)/);
  assert.match(cmake, /Threads::Threads/);
  assert.match(docs, /does not use Tensor Cores/);
  assert.match(docs, /framelabs_rtx_mode --serve/);
});
