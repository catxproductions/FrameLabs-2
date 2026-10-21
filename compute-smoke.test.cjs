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

test('CPU worker performs real semi-implicit body and angular integration', () => {
  const workerSource = read('js/compute-worker.js');
  const replies = [];
  const self = { postMessage: (message) => replies.push(message) };
  vm.runInNewContext(workerSource, { self, ArrayBuffer, Float32Array }, { filename: 'compute-worker-physics.test.js' });
  const body = new Float32Array([
    1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5
  ]);
  self.onmessage({ data: { id: 44, type: 'integrateBodies', dt: 0.05, data: body.buffer } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].backend, 'CPU worker physics');
  const result = new Float32Array(replies[0].data);
  assert.ok(Math.abs(result[2] - 1.1) < 1e-6, 'velocity is integrated and clamped');
  assert.ok(Math.abs(result[3] - -1.5) < 1e-6);
  assert.ok(Math.abs(result[0] - 1.055) < 1e-6, 'position uses semi-implicit Euler');
  assert.ok(Math.abs(result[1] - 1.925) < 1e-6);
  assert.ok(Math.abs(result[7] - 0.55) < 1e-6, 'angular velocity is integrated then damped');
  assert.ok(Math.abs(result[6] - 0.5275) < 1e-6, 'angle uses the damped angular velocity');
});

test('CPU worker performs iterative member constraints and projects velocity along each link', () => {
  const workerSource = read('js/compute-worker.js');
  const replies = [];
  const self = { postMessage: (message) => replies.push(message) };
  vm.runInNewContext(workerSource, { self, ArrayBuffer, Float64Array, Math }, { filename: 'compute-worker-constraints.test.js' });
  const nodes = new Float64Array([
    0, 0, 0, 0, 1,
    2, 0, 2, 0, 1
  ]);
  const edges = new Float64Array([0, 1, 1, 1]);
  self.onmessage({ data: { id: 45, type: 'projectConstraints', nodes: nodes.buffer, edges: edges.buffer, iterations: 1 } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].backend, 'CPU worker constraints');
  const result = new Float64Array(replies[0].data);
  assert.ok(Math.abs(result[0] - 0.5) < 1e-9, 'node A is moved toward the member rest length');
  assert.ok(Math.abs(result[5] - 1.5) < 1e-9, 'node B is moved toward the member rest length');
  assert.ok(Math.abs(result[2] - 1) < 1e-9, 'relative along-link velocity is removed');
  assert.ok(Math.abs(result[7] - 1) < 1e-9, 'both endpoints retain their shared center-of-mass velocity');
});

test('compute backend sends member constraint projection to the CPU worker', async () => {
  const backendSource = read('js/compute-backends.js');
  const workerSource = read('js/compute-worker.js');
  const status = { textContent: '' };
  class PhysicsWorkerMock {
    constructor() {
      const owner = this;
      const self = { postMessage: (data) => queueMicrotask(() => owner.onmessage?.({ data })) };
      vm.runInNewContext(workerSource, { self, ArrayBuffer, Float32Array, Float64Array, Math, Number }, { filename: 'compute-worker-embedded.test.js' });
      this.workerOnMessage = self.onmessage;
    }
    postMessage(message) { queueMicrotask(() => this.workerOnMessage({ data: message })); }
    terminate() {}
  }
  const window = { Worker: PhysicsWorkerMock };
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(backendSource, {
    window, document, navigator: {}, Worker: PhysicsWorkerMock, URL, Float32Array, Float64Array, ArrayBuffer
  }, { filename: 'compute-backends-constraints.test.js' });
  window.FrameLabCompute.setMode('cpu');
  const nodes = new Float64Array([0, 0, 0, 0, 1, 2, 0, 2, 0, 1]);
  const edges = new Float64Array([0, 1, 1, 1]);
  const solved = await window.FrameLabCompute.projectConstraints(nodes, edges, 1);
  assert.ok(Math.abs(solved[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(solved[5] - 1.5) < 1e-9);
  assert.match(status.textContent, /CPU worker integration \+ CPU constraints/);
});

test('live physics backend exposes selectable mode and a working main-CPU integration fallback', async () => {
  const source = read('js/compute-backends.js');
  const status = { textContent: '' };
  const window = {};
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(source, { window, document, navigator: {}, Float32Array, ArrayBuffer, URL }, { filename: 'compute-backends-live-physics.test.js' });
  window.FrameLabCompute.setMode('main');
  const body = new Float32Array([
    1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5
  ]);
  const result = await window.FrameLabCompute.integrateBodies(body, 0.05);
  assert.equal(result.backend, 'Main-thread CPU');
  assert.ok(Math.abs(result.data[0] - 1.055) < 1e-6);
  assert.ok(Math.abs(result.data[7] - 0.55) < 1e-6);
  assert.equal(window.FrameLabCompute.getMode(), 'main');
  assert.match(status.textContent, /Main-thread CPU.*1 bodies/);
});

test('actual node and debris motion paths use the compute backend, not only the member diagnostic scan', () => {
  const js = read('js/main.js');
  assert.match(js, /async function integrateMotionBatch\(packed,dt\)/);
  assert.match(js, /async function updateMemberPhysics\(dt\)/);
  assert.match(js, /async function updateDebris\(dt\)/);
  assert.match(js, /await integrateMotionBatch\(packed,dt\)/);
  assert.match(js, /await window\.FrameLabCompute\.projectConstraints\(state,new Float64Array\(edgeRows\),QUALITY_PROFILE\.constraintIterations\)/);
  assert.match(read('js/compute-backends.js'), /worker\.postMessage\(\{ id, type: 'projectConstraints'/);
  assert.match(js, /await updateMemberPhysics\(dt\)[\s\S]*await updateDebris\(dt\)/);
  assert.match(js, /async function processPhysicsSteps\(\)/);
  assert.match(read('index.html'), /id="computeMode"/);
});

test('automatic physics benchmarking conservatively chooses CPU when WebGPU is unavailable', async () => {
  const source = read('js/compute-backends.js');
  const window = {};
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: () => null
  };
  vm.runInNewContext(source, { window, document, navigator: {}, Float32Array, ArrayBuffer, URL }, { filename: 'compute-backends-auto-physics.test.js' });
  const result = await window.FrameLabCompute.benchmarkPhysicsBackends();
  assert.equal(result.available, false);
  assert.equal(result.preferGPU, false);
  assert.match(result.reason, /CPU worker/);
});

test('CPU mode routes live body integration through the persistent worker', async () => {
  const source = read('js/compute-backends.js');
  const workerInstances = [];
  const status = { textContent: '' };
  class PhysicsWorkerMock {
    constructor(url) { this.url = String(url); workerInstances.push(this); }
    postMessage(message) {
      if (message.type === 'integrateBodies') {
        const data = new Float32Array(message.data), stride = 13, dt = message.dt;
        for (let i = 0; i < data.length / stride; i++) {
          const b = i * stride;
          const vx = Math.max(-data[b + 10], Math.min(data[b + 10], data[b + 2] + data[b + 4] * dt));
          const vy = Math.max(-data[b + 11], Math.min(data[b + 11], data[b + 3] + data[b + 5] * dt));
          const omega = Math.max(-data[b + 12], Math.min(data[b + 12], data[b + 7] + data[b + 8] * dt)) * data[b + 9];
          data[b + 2] = vx; data[b + 3] = vy; data[b] += vx * dt; data[b + 1] += vy * dt;
          data[b + 7] = omega; data[b + 6] += omega * dt;
        }
        queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'integrateBodies', backend: 'CPU worker physics', data: data.buffer } }));
        return;
      }
      const { id, demands, capacities } = message;
      queueMicrotask(() => this.onmessage({ data: { id, backend: 'Web Worker (CPU)', count: demands.length, maxUtil: 0, meanUtil: 0, overloaded: 0 } }));
    }
    terminate() {}
  }
  const window = { Worker: PhysicsWorkerMock };
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(source, { window, document, navigator: {}, Worker: PhysicsWorkerMock, Float32Array, ArrayBuffer, URL }, { filename: 'compute-backends-worker-physics.test.js' });
  window.FrameLabCompute.setMode('cpu');
  const body = new Float32Array([1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5]);
  const result = await window.FrameLabCompute.integrateBodies(body, 0.05);
  assert.equal(result.backend, 'CPU worker physics');
  assert.equal(workerInstances.length, 1);
  assert.ok(Math.abs(result.data[0] - 1.055) < 1e-6);
  assert.match(status.textContent, /CPU worker physics.*1 bodies/);
});

test('collapse dust and fire smoke particles animate in world space and respect quality budgets', () => {
  const js = read('js/main.js');
  const start = js.indexOf('function addAtmosphericParticle(');
  const end = js.indexOf('function spawnMemberDebris(', start);
  assert.ok(start >= 0 && end > start, 'atmospheric particle functions are present as one testable block');
  const state = { atmosphericParticles: [], memberLinks: [], nodes: {}, debris: [] };
  const context = {
    sim: state,
    MAX_ATMOSPHERIC_PARTICLES: 24,
    QUALITY_PROFILE: { maxParticles: 24 },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    Math,
    Number,
    globalThis: {}
  };
  vm.runInNewContext(`${js.slice(start, end)}\nglobalThis.particleTestApi = { spawnDustPlume, spawnSmokePuff, updateAtmosphericParticles };`, context, { filename: 'atmospheric-particles.test.js' });
  const api = context.globalThis.particleTestApi;
  api.spawnDustPlume(2, 3, 1.4, 0.8, 0.2);
  assert.ok(state.atmosphericParticles.length >= 15, 'a structural failure emits a multi-particle dust plume');
  assert.ok(state.atmosphericParticles.every(p => p.kind === 'dust' && Number.isFinite(p.x + p.y + p.vx + p.vy)), 'dust particles hold finite world-space state');
  const particle = state.atmosphericParticles[0];
  const initialX = particle.x, initialAge = particle.age;
  api.updateAtmosphericParticles(.05);
  assert.ok(particle.age > initialAge, 'particles age on the visual clock');
  assert.notEqual(particle.x, initialX, 'particles drift independently of the physics substep');
  api.spawnSmokePuff(1, 2, 0, 0, 1);
  const smoke = state.atmosphericParticles.find(p => p.kind === 'smoke');
  assert.ok(smoke && smoke.vy > 0 && smoke.growth > 0, 'flame smoke rises and expands');
  state.memberLinks.push({ id: 'columns|0,0', nodeA: 'a', nodeB: 'b', e: { burning: true, failed: false, x: 0, smokeEmissionClock: 0 } });
  state.nodes.a = { position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 } };
  state.nodes.b = { position: { x: 2, y: 2 }, velocity: { x: 0, y: 0 } };
  for (let i = 0; i < 4; i++) api.updateAtmosphericParticles(.05);
  assert.ok(state.atmosphericParticles.some(p => p.kind === 'smoke' && p.y >= 2), 'burning members automatically emit smoke into the world-space system');
  state.memberLinks.length = 0;
  for (let i = 0; i < 20; i++) api.spawnDustPlume(1, 1, 2);
  assert.ok(state.atmosphericParticles.length <= 24, 'particle count is capped by the quality budget');
  api.updateAtmosphericParticles(0.05);
  assert.ok(state.atmosphericParticles.every(p => p.age < p.life), 'expired particles are removed instead of accumulating');
});

test('collapse and impact events emit dust, burning sources emit smoke, and canvas renders atmospheric particles', () => {
  const js = read('js/main.js');
  assert.match(js, /function failMember\([\s\S]*?spawnDustPlume\(/);
  assert.match(js, /function handleGroundImpact\([\s\S]*?spawnDustPlume\(/);
  assert.match(js, /function emitFireSmoke\([\s\S]*?spawnSmokePuff\(/);
  assert.match(js, /drawExplosionEffects\(\);drawAtmosphericParticles\(\);/);
  assert.match(js, /updateAtmosphericParticles\(elapsed\)/);
  assert.match(js, /maxParticles:170/);
  assert.match(js, /maxParticles:360/);
  assert.match(js, /maxParticles:600/);
});
