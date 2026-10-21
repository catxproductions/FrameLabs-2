'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the built-in example payload is valid JSON and contains the four expected designs', () => {
  const html = read('index.html');
  const match = html.match(/<script type="application\/json" id="builtinExamplesData">([\s\S]*?)<\/script>/);
  assert.ok(match, 'built-in example payload is present');
  const examples = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(examples).sort(), ['large-building', 'large-cinema', 'research-center', 'the-lab']);
  for (const [key, example] of Object.entries(examples)) {
    assert.ok(example.data && typeof example.data === 'object', `${key} has member data`);
    assert.ok(Number.isInteger(example.memberCount) && example.memberCount > 0, `${key} has a positive member count`);
    const actualCounts = Object.fromEntries(Object.entries(example.data).map(([group, members]) => [group, members.length]));
    assert.deepEqual(actualCounts, example.counts, `${key} group counts match the saved layout`);
    const structuralCount = ['columns', 'beams', 'slabs', 'braces'].reduce((sum, group) => sum + (actualCounts[group] || 0), 0);
    assert.equal(structuralCount, example.memberCount, `${key} total matches memberCount`);
  }
});

test('all required local assets exist and the page loads the model before the simulation', () => {
  const html = read('index.html');
  assert.match(html, /<script src="\.\/js\/compute-backends\.js"><\/script>\s*<script src="\.\/js\/physics-model\.js"><\/script>\s*<script src="\.\/js\/main\.js"><\/script>/);
  for (const asset of ['css/styles.css', 'js/main.js', 'js/compute-backends.js', 'js/compute-worker.js', 'js/physics-model.js']) {
    assert.ok(fs.statSync(path.join(root, asset)).isFile(), `${asset} exists`);
  }
  const pageURL = 'https://catxproductions.github.io/framelabs/';
  const backendURL = new URL('./js/compute-backends.js', pageURL);
  const workerURL = new URL('./compute-worker.js', backendURL);
  assert.equal(workerURL.href, 'https://catxproductions.github.io/framelabs/js/compute-worker.js');
});

test('CPU worker computes utilization, including empty and non-finite values', () => {
  const workerSource = read('js/compute-worker.js');
  const replies = [];
  const self = { postMessage: (message) => replies.push(message) };
  vm.runInNewContext(workerSource, { self }, { filename: 'compute-worker.js' });

  self.onmessage({ data: { id: 7, demands: [0, 5, 12], capacities: [1, 10, 4] } });
  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].backend, 'Web Worker (CPU)');
  assert.equal(replies[0].count, 3);
  assert.equal(replies[0].maxUtil, 3);
  assert.equal(replies[0].overloaded, 1);
  assert.equal(replies[0].meanUtil, (0 + 0.5 + 3) / 3);

  self.onmessage({ data: { id: 8, demands: [], capacities: [] } });
  assert.equal(replies[1].count, 0);
  assert.equal(replies[1].meanUtil, 0);

  self.onmessage({ data: { id: 9, demands: [Number.NaN, 2], capacities: [0, Number.POSITIVE_INFINITY] } });
  assert.equal(replies[2].maxUtil, 200);
  assert.equal(replies[2].overloaded, 1);
});

test('compute backend registers a worker URL relative to its own script and scans on CPU fallback', async () => {
  const source = read('js/compute-backends.js');
  const workerInstances = [];
  const status = { textContent: '' };
  class WorkerMock {
    constructor(url) { this.url = String(url); workerInstances.push(this); }
    postMessage(message) {
      const { id, demands, capacities } = message;
      let maxUtil = 0, sum = 0, overloaded = 0;
      for (let i = 0; i < demands.length; i++) {
        const ratio = Math.max(0, Number(demands[i]) || 0) / Math.max(0.01, Number(capacities[i]) || 0.01);
        maxUtil = Math.max(maxUtil, ratio); sum += ratio; if (ratio >= 1) overloaded++;
      }
      queueMicrotask(() => this.onmessage({ data: { id, backend: 'Web Worker (CPU)', count: demands.length, maxUtil, meanUtil: demands.length ? sum / demands.length : 0, overloaded } }));
    }
    terminate() {}
  }
  const window = {};
  window.Worker = WorkerMock;
  const document = {
    baseURI: 'https://catxproductions.github.io/framelabs/',
    currentScript: { src: 'https://catxproductions.github.io/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  let gpuAdapterRequests = 0;
  const navigator = { gpu: { requestAdapter: async () => { gpuAdapterRequests++; return null; } } };
  const context = { window, document, navigator, Worker: WorkerMock, URL };
  vm.runInNewContext(source, context, { filename: 'compute-backends.js' });
  assert.equal(workerInstances.length, 1);
  assert.equal(workerInstances[0].url, 'https://catxproductions.github.io/framelabs/js/compute-worker.js');
  const result = await window.FrameLabCompute.scan(new Float32Array([0, 5, 12]), new Float32Array([1, 10, 4]));
  assert.equal(result.backend, 'Web Worker (CPU)');
  assert.equal(result.maxUtil, 3);
  assert.equal(result.overloaded, 1);
  assert.match(status.textContent, /Web Worker \(CPU\).*3 members/);

  // A GPU adapter rejection should fall back to the CPU worker without losing the scan.
  const largeDemands = new Float32Array(2048).fill(2);
  const largeCapacities = new Float32Array(2048).fill(1);
  // This test's backend was created without WebGPU; separately assert the no-GPU path
  // returns a scan for a large snapshot as well.
  const largeResult = await window.FrameLabCompute.scan(largeDemands, largeCapacities);
  assert.equal(largeResult.count, 2048);
  assert.equal(largeResult.maxUtil, 2);
  assert.equal(gpuAdapterRequests, 1, 'GPU is attempted once and disabled after a reported initialization failure');
  const largeResultAgain = await window.FrameLabCompute.scan(largeDemands, largeCapacities);
  assert.equal(largeResultAgain.backend, 'Web Worker (CPU)');
  assert.equal(gpuAdapterRequests, 1, 'a failed GPU backend is not repeatedly initialized every scan');
});

test('worker crashes fall back to a main-thread scan instead of leaving a pending promise', async () => {
  const source = read('js/compute-backends.js');
  const status = { textContent: '' };
  class CrashingWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage() { this.onerror?.({ message: 'simulated worker crash', preventDefault() {} }); }
    terminate() {}
  }
  const window = { Worker: CrashingWorker };
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(source, { window, document, navigator: {}, Worker: CrashingWorker, URL }, { filename: 'compute-backends-crash.js' });
  const result = await window.FrameLabCompute.scan(new Float32Array([3, 4]), new Float32Array([1, 2]));
  assert.equal(result.backend, 'Main-thread fallback');
  assert.equal(result.maxUtil, 3);
  assert.match(status.textContent, /Main-thread fallback/);
});

test('simulation uses fixed 120 Hz physics substeps and exposes an accessible UI visibility toggle', () => {
  const html = read('index.html');
  const js = read('js/main.js');
  const css = read('css/styles.css');
  assert.match(html, /id="viewModeToggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="viewModeLabel">Hide UI<\/span>/);
  assert.match(html, /id="overlayToggle"/);
  assert.match(html, /id="overlayModeLabel">Icons: On<\/span>/);
  assert.match(html, /id="qualityPreset"/);
  assert.match(html, /id="surfaceMoisture"/);
  assert.match(html, /id="waterLevel"/);
  assert.match(html, /data-mode="tether"/);
  assert.match(js, /DT=1\/120/);
  assert.match(js, /physicsAccumulator/);
  assert.match(js, /MAX_PHYSICS_STEPS_PER_FRAME=8/);
  assert.match(js, /function runPerformanceBenchmark\(\)/);
  assert.match(js, /function beginGravityTether\(/);
  assert.match(js, /function drawContactShadows\(/);
  assert.match(js, /function drawWetHighlights\(/);
  assert.match(js, /setSimulationOverlays\(!showSimulationOverlays\)/);
  assert.match(js, /environmentAcceleration/);
  assert.match(js, /stepPhysics\(DT\)/);
  assert.match(js, /setSimulationOnly\(!document\.body\.classList\.contains\('simulation-only'\)\)/);
  assert.match(css, /body\.simulation-only \.panel/);
  assert.match(css, /body\.simulation-only canvas\{width:100%;height:100%;aspect-ratio:auto/);
});


test('GPU benchmark degrades cleanly when WebGPU is missing', async () => {
  const source = read('js/compute-backends.js');
  class WorkerMock {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id, count: 0, backend: 'Web Worker (CPU)', maxUtil: 0, meanUtil: 0, overloaded: 0 } })); }
    terminate() {}
  }
  const window = { Worker: WorkerMock };
  const document = { baseURI: 'https://example.test/framelabs/', currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' }, getElementById: () => null };
  vm.runInNewContext(source, { window, document, navigator: {}, Worker: WorkerMock, URL }, { filename: 'compute-benchmark-no-gpu.js' });
  const result = await window.FrameLabCompute.benchmarkGPU();
  assert.equal(result.available, false);
  assert.equal(result.averageMs, null);
  assert.match(result.reason, /WebGPU unavailable/);
});
