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
  assert.match(html, /<script src="\.\/js\/compute-backends\.js"><\/script>\s*<script src="\.\/js\/materials\.js"><\/script>\s*<script src="\.\/js\/physics-model\.js"><\/script>\s*<script src="\.\/js\/replay-tools\.js"><\/script>\s*<script src="\.\/js\/main\.js"><\/script>/);
  for (const asset of ['css/styles.css', 'js/main.js', 'js/compute-backends.js', 'js/compute-worker.js', 'js/materials.js', 'js/physics-model.js']) {
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

test('simulation uses fixed 120 Hz physics substeps and exposes immersive fullscreen controls', () => {
  const html = read('index.html');
  const js = read('js/main.js');
  const css = read('css/styles.css');
  assert.match(html, /id="viewModeToggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="viewModeLabel">Fullscreen<\/span>/);
  assert.match(html, /Enter immersive fullscreen \(F\)/);
  assert.match(js, /requestFullscreen\(\)/);
  assert.match(js, /exitFullscreen\(\)/);
  assert.match(html, /id="overlayToggle"/);
  assert.match(html, /id="overlayModeLabel">Icons: On<\/span>/);
  assert.match(html, /id="qualityPreset"/);
  assert.match(html, /id="surfaceMoisture"/);
  assert.match(html, /id="waterLevel"/);
  assert.match(html, /data-mode="tether"/);
  assert.match(js, /DT=1\/120/);
  assert.match(js, /physicsAccumulator/);
  assert.match(js, /MAX_PHYSICS_STEPS_PER_FRAME=4/);
  assert.match(js, /If physics falls behind, the next animation frame services the bounded backlog/);
  assert.match(js, /function runPerformanceBenchmark\(\)/);
  assert.match(js, /function beginGravityTether\(/);
  assert.match(js, /function drawContactShadows\(/);
  assert.match(js, /function drawWetHighlights\(/);
  assert.match(js, /setSimulationOverlays\(!showSimulationOverlays\)/);
  assert.match(js, /environmentAcceleration/);
  assert.match(js, /stepPhysics\(DT\)/);
  assert.match(js, /function enterImmersiveFullscreen\(\)/);
  assert.match(js, /function exitImmersiveFullscreen\(\)/);
  assert.match(js, /document\.addEventListener\('fullscreenchange'/);
  assert.match(css, /body\.simulation-only \.panel/);
  assert.match(css, /body\.simulation-only \.stage/);
  assert.match(css, /body\.simulation-only #scene/);
  assert.match(css, /object-fit: contain/);
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
  assert.match(js, /async function integrateMotionBatch\(packed,dt,scratchKey='nodeMotionPacked',rebuildFallback=null\)/);
  assert.match(js, /async function updateMemberPhysics\(dt\)/);
  assert.match(js, /async function updateDebris\(dt\)/);
  assert.match(js, /await integrateMotionBatch\(packed,dt,'nodeMotionPacked'/);
  assert.match(js, /await integrateMotionBatch\(packed,dt,'debrisMotionPacked'/);
  assert.match(js, /await window\.FrameLabCompute\.projectConstraints\(state,edges,QUALITY_PROFILE\.constraintIterations,\{transferOwnership:true\}\)/);
  assert.match(js, /function buildDebrisMemberCollisionIndex\(\)/);
  assert.match(js, /queryDebrisMemberCollisionLinks\(collisionIndex\.columns/);
  assert.match(js, /queryDebrisMemberCollisionLinks\(collisionIndex\.floors/);
  assert.match(read('js/compute-worker.js'), /Number\.isInteger\(payload\.nodeLength\)/);
  assert.match(read('js/compute-worker.js'), /edges: edges\.buffer/);
  assert.match(read('js/compute-backends.js'), /worker\.postMessage\(\{\s*id, type: 'projectConstraints'/);
  assert.match(js, /await updateMemberPhysics\(dt\)[\s\S]*await updateDebris\(dt\)/);
  assert.match(js, /async function processPhysicsSteps\(\)/);
  assert.match(read('index.html'), /id="computeMode"/);
});

test('live motion paths pass the typed-array constructor to the scratch-buffer helper', () => {
  const js = read('js/main.js');
  assert.match(js, /acquireScratchArray\('nodeMotionPacked',Float32Array,motionNodes\.length\*stride\)/);
  assert.match(js, /acquireScratchArray\('debrisMotionPacked',Float32Array,motionBodies\.length\*stride\)/);
  for (const match of js.matchAll(/acquireScratchArray\(([^\n]*)\)/g)) {
    const args = match[1];
    assert.match(args, /^(?:'[^']+'|[^,]+),\s*(?:Float32Array|Float64Array),\s*.+$/, `scratch buffer call supplies key, typed-array constructor, and length: ${args}`);
  }
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
    EFFECT_SETTINGS: { fireRealism: 0.8, fireDensity: 1, fireSize: 1, dustRealism: 0.72, dustDensity: 1, dustSize: 1, smokeRealism: 0.78, smokeDensity: 1, smokeSize: 1 },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    windDirectionSign: () => 1,
    windSpeedRatio: () => 0,
    windGustFactor: () => 1,
    Math,
    Number,
    globalThis: {}
  };
  vm.runInNewContext(`${js.slice(start, end)}\nglobalThis.particleTestApi = { spawnDustPlume, spawnSmokePuff, updateAtmosphericParticles };`, context, { filename: 'atmospheric-particles.test.js' });
  const api = context.globalThis.particleTestApi;
  api.spawnDustPlume(2, 3, 1.4, 0.8, 0.2);
  assert.ok(state.atmosphericParticles.length >= 15, 'a structural failure emits a multi-particle dust plume');
  assert.ok(state.atmosphericParticles.every(p => p.kind === 'dust' && Number.isFinite(p.x + p.y + p.vx + p.vy)), 'dust particles hold finite world-space state');
  assert.ok(state.atmosphericParticles.every(p => p.vy > 0.45), 'dust particles launch upwards with visible lift');
  const particle = state.atmosphericParticles[0];
  const initialX = particle.x, initialAge = particle.age;
  api.updateAtmosphericParticles(.05);
  assert.ok(particle.age > initialAge, 'particles age on the visual clock');
  assert.notEqual(particle.x, initialX, 'particles drift independently of the physics substep');
  api.spawnSmokePuff(1, 2, 0, 0, 1);
  const smoke = state.atmosphericParticles.find(p => p.kind === 'smoke');
  assert.ok(smoke && smoke.vy > 0.65 && smoke.growth > 0, 'smoke rises strongly and expands');
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
  const beforeDustOff = state.atmosphericParticles.length;
  context.EFFECT_SETTINGS.dustDensity = 0;
  api.spawnDustPlume(1, 1, 1);
  assert.equal(state.atmosphericParticles.length, beforeDustOff, 'zero dust density stops new dust emissions');
  context.EFFECT_SETTINGS.dustDensity = 1;
  context.EFFECT_SETTINGS.smokeDensity = 0;
  const beforeSmokeOff = state.atmosphericParticles.length;
  api.spawnSmokePuff(1, 2, 0, 0, 1);
  assert.equal(state.atmosphericParticles.length, beforeSmokeOff, 'zero smoke density stops new smoke emissions');
  context.EFFECT_SETTINGS.dustDensity = 10;
  for (let i = 0; i < 10; i++) api.spawnDustPlume(1, 1, 2);
  assert.ok(state.atmosphericParticles.length > 24, 'maximum dust density can use the expanded atmospheric particle budget');
  assert.ok(state.atmosphericParticles.length <= 120, 'expanded particles remain capped at five times the test quality budget');
});

test('maximum smoke density produces roughly five times the emissions of the previous maximum', () => {
  const js = read('js/main.js');
  const start = js.indexOf('function addAtmosphericParticle(');
  const end = js.indexOf('function spawnMemberDebris(', start);
  assert.ok(start >= 0 && end > start);
  function smokeCountAtDensity(density) {
    const state = {
      atmosphericParticles: [],
      memberLinks: [{ id: 'columns|0,0', nodeA: 'a', nodeB: 'b', e: { burning: true, failed: false, x: 0, smokeEmissionClock: 0 } }],
      nodes: {
        a: { position: { x: 0, y: 2 }, velocity: { x: 0, y: 0 } },
        b: { position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 } }
      },
      debris: [],
      time: 0
    };
    const context = {
      sim: state,
      MAX_ATMOSPHERIC_PARTICLES: 3000,
      QUALITY_PROFILE: { maxParticles: 3000 },
      EFFECT_SETTINGS: { fireRealism: .8, fireDensity: 1, fireSize: 1, dustRealism: .72, dustDensity: 1, dustSize: 1, smokeRealism: .78, smokeDensity: density, smokeSize: 1 },
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      windDirectionSign: () => 1,
      windSpeedRatio: () => 0,
      windGustFactor: () => 1,
      Math,
      Number,
      globalThis: {}
    };
    vm.runInNewContext(`${js.slice(start, end)}\nglobalThis.smokeRateApi = { updateAtmosphericParticles };`, context, { filename: 'smoke-density-rate.test.js' });
    for (let i = 0; i < 60; i++) context.globalThis.smokeRateApi.updateAtmosphericParticles(.05);
    return state.atmosphericParticles.filter(p => p.kind === 'smoke').length;
  }
  const previousMaximum = smokeCountAtDensity(2);
  const expandedMaximum = smokeCountAtDensity(10);
  assert.ok(previousMaximum > 0);
  assert.ok(expandedMaximum >= previousMaximum * 4.5, `expanded density should emit about 5x smoke (old=${previousMaximum}, new=${expandedMaximum})`);
});

test('fire, dust, and smoke expose live visual sliders with valid setting bindings', () => {
  const html = read('index.html');
  const js = read('js/main.js');
  for (const id of ['fireRealism','fireDensity','fireSize','dustRealism','dustDensity','dustSize','smokeRealism','smokeDensity','smokeSize']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*type="range"|type="range"[^>]*id="${id}"`), `${id} is a slider`);
    assert.match(js, new RegExp(`'${id}','${id}','${id}Out'`), `${id} updates a live setting`);
  }
  assert.match(js, /const EFFECT_SETTINGS=\{fireRealism:/);
  assert.ok(js.includes("input.classList.toggle('is-zero-disabled',isZero)"), 'zero values gray out their slider');
  assert.ok(js.includes("out.textContent=isZero?'Disabled':String(Math.round(percent))+'%'"), 'zero values show Disabled in the readout');
  assert.ok(js.includes("const rawFireSize=Number(EFFECT_SETTINGS.fireSize),fireSize=clamp(Number.isFinite(rawFireSize)?rawFireSize:1,0,10)"), 'zero flame size turns flame drawing off');
  assert.ok(js.includes("if(isZero&&(key==='dustDensity'||key==='dustSize'))sim.atmosphericParticles=(sim.atmosphericParticles||[]).filter(p=>p.kind!=='dust')"), 'zero dust settings clear existing dust immediately');
  assert.ok(js.includes("if(isZero&&(key==='smokeDensity'||key==='smokeSize'))sim.atmosphericParticles=(sim.atmosphericParticles||[]).filter(p=>p.kind!=='smoke')"), 'zero smoke settings clear existing smoke immediately');
  assert.match(js, /const densityExpansion=clamp\(visualDensity\/2,1,5\)/);
  assert.match(js, /const limit=Math\.min\(3000,Math\.floor\(qualityBudget\*densityExpansion\)\)/);
  assert.match(js, /rise=p\.kind==='smoke'\?\.75:\.32/);
  const css = read('css/styles.css');
  assert.ok(css.includes('.effect-control-disabled input[type="range"]'), 'zeroed sliders use disabled styling but remain interactive');
  for (const id of ['fireDensity','fireSize','dustDensity','smokeDensity']) {
    assert.match(html, new RegExp(`id="${id}" type="range" min="0" max="1000"`), `${id} reaches five times its old maximum`);
  }
  for (const id of ['dustSize','smokeSize']) {
    assert.match(html, new RegExp(`id="${id}" type="range" min="0" max="1250"`), `${id} reaches five times its old maximum`);
  }
  assert.match(js, /source\.e\.smokeEmissionClock=accumulated-available\*source\.interval/);
  assert.ok(js.includes('const smokeDensity=clamp(Number(EFFECT_SETTINGS.smokeDensity)||0,0,10)'), 'smoke scheduler honors the extended density maximum');
  assert.match(js, /due\.length<240/, 'smoke emission budget is extended fivefold');
  assert.match(js, /sim\.smokeEmissionCursor=\(sourceStart\+Math\.max\(1,emitCount\)\)%sources\.length/, 'high-density smoke emissions rotate across sources');
  assert.match(js, /const realism=clamp\(Number\(EFFECT_SETTINGS\[p\.kind==='smoke'\?'smokeRealism':'dustRealism'\]\)/);
});

test('maximum wind applies a direction-aware force to both supported and free structural nodes', () => {
  const js = read('js/main.js');
  assert.match(js, /windAx=windDirection\*windRatio\*windRatio\*windGust\*\(\.16\+1\.05\*windHeight\)/);
  assert.match(js, /-1\.15\*node\.velocity\.x\+windAx/);
  assert.match(js, /node\.acceleration\.x=-\.22\*node\.velocity\.x\+windAx/);
  assert.match(js, /speed\*speed\*\(\.18\+1\.05\*level\/Math\.max\(1,NY\)\)\*gust/);
  assert.match(js, /source\.baseInterval\/\(intervalBoost\*Math\.max\(\.08,smokeDensity\)\)/, 'smoke density adjusts emission frequency');
  assert.match(js, /node\.windPreviewSway=sim\.lateralDisp\[node\.referenceLevel\]\|\|0/);
  assert.match(js, /node\.position\.x\+sway-previousSway/);
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


test('debris collision hot path is routed to optional C++ WebAssembly with JavaScript fallback', () => {
  const main = read('js/main.js');
  const backend = read('js/compute-backends.js');
  const worker = read('js/compute-worker.js');
  const cpp = read('cpp/physics_core.cpp');
  assert.match(main, /await resolveDebrisCollisions\(dt\)/);
  assert.match(main, /FrameLabCompute\?\.resolveDebrisPairs/);
  assert.match(backend, /async function resolveDebrisPairs\(bodies, pairs, moisture = 0, options = \{\}\)/);
  assert.match(worker, /payload\.type === 'resolveDebrisPairs'/);
  assert.match(cpp, /int resolve_debris_pairs\(/);
  assert.match(main, /finishDebrisCollisionFragments\(fragments\)/);
});


test('wind affects structural demand and uses the sustained-overload failure path', () => {
  const js = read('js/main.js');
  const model = read('js/physics-model.js');
  const html = read('index.html');
  assert.match(js, /PHYSICS_MODEL\?\.windMemberDemand/);
  assert.match(js, /col\.windDemand=windLoadForMember\('column',col\);col\.demand\+=col\.windDemand/);
  assert.match(js, /beam\.windDemand=windDemand;beam\.demand=d/);
  assert.match(js, /brace\.windDemand=windLoadForMember\('brace',brace\);brace\.demand=.*brace\.windDemand/);
  assert.match(js, /if\(util>1\)\{sim\.overloadTimers/);
  assert.match(model, /function windMemberDemand\(/);
  assert.match(html, /Sustained severe wind can weaken and break vulnerable members/);
});


test('CPU worker reuses the transferred input buffer and respects its active body length', () => {
  const workerSource = read('js/compute-worker.js');
  const replies = [];
  const self = { postMessage: (message) => replies.push(message) };
  vm.runInNewContext(workerSource, { self, ArrayBuffer, Float32Array, Math, Number }, { filename: 'compute-worker-buffer-reuse.test.js' });
  const scratch = new ArrayBuffer(256);
  const body = new Float32Array(scratch);
  body.set([1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5]);
  body[13] = 9876;
  self.onmessage({ data: { id: 91, type: 'integrateBodies', dt: 0.05, data: scratch, length: 13 } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].data, scratch, 'worker returns the same transferred buffer instead of allocating a result buffer');
  assert.equal(replies[0].length, 13, 'caller receives the active view length even when buffer capacity is larger');
  const result = new Float32Array(replies[0].data);
  assert.ok(Math.abs(result[0] - 1.055) < 1e-6);
  assert.equal(result[13], 9876, 'unused scratch capacity is not integrated');
});

test('performance backend pools GPU buffers, benchmarks crossover sizes, and exposes diagnostics', () => {
  const backend = read('js/compute-backends.js');
  const main = read('js/main.js');
  assert.match(backend, /const gpuBuffers = \{ body: \{\}, scan: \{\} \}/);
  assert.match(backend, /function ensureGPUBuffer\(/);
  assert.match(backend, /let gpuBodyQueue = Promise\.resolve\(\)/);
  assert.match(backend, /let gpuScanQueue = Promise\.resolve\(\)/);
  assert.match(backend, /async function integrateGPUUnlocked\(/);
  assert.match(backend, /async function scanGPUUnlocked\(/);
  assert.match(backend, /GPU_BENCHMARK_COUNTS = \[256, 1024, 4096\]/);
  assert.match(backend, /measurements\.slice\(i\)\.every\(sample => sample\.preferGPU\)/);
  assert.match(backend, /getDiagnostics: \(\) => \(\{/);
  assert.match(backend, /setRuntimeStatus\(text\)/);
  assert.match(backend, /options\.transferOwnership === true/);
  assert.match(backend, /options && options\.transferOwnership === true/);
  assert.match(main, /resolveDebrisPairs\(packed,pairIndices,ENVIRONMENT\.moisture,\{transferOwnership:true\}\)/);
  assert.match(main, /pairs\.add\(ia\*live\.length\+ib\)/);
  assert.match(main, /acquireScratchArray\('constraintNodes'/);
  assert.match(main, /acquireScratchArray\('constraintEdges'/);
  assert.match(main, /transferOwnership:true/);
  assert.match(main, /const MAX_PHYSICS_STEPS_PER_FRAME=4/);
  assert.doesNotMatch(main, /if\(sim\.running&&physicsAccumulator\+1e-9>=DT\)void processPhysicsSteps\(\)/);
});

test('compute diagnostics remain usable without WebGPU or workers', () => {
  const source = read('js/compute-backends.js');
  const window = {};
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: () => null
  };
  vm.runInNewContext(source, { window, document, navigator: {}, Float32Array, Float64Array, ArrayBuffer, URL }, { filename: 'compute-backends-diagnostics.test.js' });
  const diagnostics = window.FrameLabCompute.getDiagnostics();
  assert.equal(diagnostics.mode, 'auto');
  assert.equal(diagnostics.autoGPUThreshold, null);
  assert.equal(diagnostics.gpuState, 'not initialized');
  assert.equal(diagnostics.bodyBufferCapacityBytes, 0);
});


test('large debris solver can transfer exact input batches without backend copies', async () => {
  const source = read('js/compute-backends.js');
  const status = { textContent: '' };
  const requests = [];
  class TransferWorkerMock {
    constructor(url) { this.url = String(url); }
    postMessage(message, transfer = []) {
      requests.push({ message, transfer });
      if (message.type !== 'resolveDebrisPairs') return;
      const events = new Float64Array((new Uint32Array(message.pairs).length / 2) * 4);
      events[0] = 1; events[1] = 0.5; events[2] = 2; events[3] = 1;
      queueMicrotask(() => this.onmessage?.({ data: {
        id: message.id, type: message.type,
        backend: 'C++ WebAssembly · debris collision solver',
        bodies: message.bodies, events: events.buffer
      } }));
    }
    terminate() {}
  }
  const window = { Worker: TransferWorkerMock };
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(source, {
    window, document, navigator: {}, Worker: TransferWorkerMock,
    Float32Array, Float64Array, Uint32Array, ArrayBuffer, URL
  }, { filename: 'compute-backends-debris-transfer.test.js' });
  window.FrameLabCompute.setMode('cpu');
  const bodies = new Float64Array(19 * 2);
  bodies[6] = 2; bodies[7] = 1; bodies[8] = 1; bodies[17] = 1;
  bodies[19 + 6] = 2; bodies[19 + 7] = 1; bodies[19 + 8] = 1; bodies[19 + 17] = 1;
  const pairs = new Uint32Array([0, 1]);
  const bodyBuffer = bodies.buffer, pairBuffer = pairs.buffer;
  const result = await window.FrameLabCompute.resolveDebrisPairs(bodies, pairs, 0, { transferOwnership: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message.bodies, bodyBuffer, 'the original exact body buffer is sent to the worker');
  assert.equal(requests[0].message.pairs, pairBuffer, 'the original exact pair buffer is sent to the worker');
  assert.ok(requests[0].transfer.includes(bodyBuffer) && requests[0].transfer.includes(pairBuffer));
  assert.equal(result.bodies.length, 38);
  assert.equal(result.events.length, 4);
  const diagnostics = window.FrameLabCompute.getDiagnostics();
  assert.equal(diagnostics.wasmDebrisBatches, 1);
  assert.ok(diagnostics.transferredBytes >= bodyBuffer.byteLength + pairBuffer.byteLength);
});


test('constraint worker compacts oversized scratch and supports exact zero-copy transfers', async () => {
  const backendSource = read('js/compute-backends.js');
  const workerSource = read('js/compute-worker.js');
  const status = { textContent: '' };
  const requests = [];
  class ConstraintWorkerMock {
    constructor() {
      const owner = this;
      const self = { postMessage: (data) => queueMicrotask(() => owner.onmessage?.({ data })) };
      vm.runInNewContext(workerSource, { self, ArrayBuffer, Float32Array, Float64Array, Math, Number }, { filename: 'constraint-worker-transfer.test.js' });
      this.workerOnMessage = self.onmessage;
    }
    postMessage(message, transfer = []) {
      requests.push({ message, transfer });
      queueMicrotask(() => this.workerOnMessage({ data: message }));
    }
    terminate() {}
  }
  const window = { Worker: ConstraintWorkerMock };
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  vm.runInNewContext(backendSource, {
    window, document, navigator: {}, Worker: ConstraintWorkerMock, URL,
    Float32Array, Float64Array, Uint32Array, ArrayBuffer
  }, { filename: 'compute-backends-constraint-transfer.test.js' });
  window.FrameLabCompute.setMode('cpu');
  const nodeBuffer = new ArrayBuffer(1024), edgeBuffer = new ArrayBuffer(1024);
  const nodes = new Float64Array(nodeBuffer, 0, 10);
  nodes.set([0, 0, 0, 0, 1, 2, 0, 2, 0, 1]);
  const edges = new Float64Array(edgeBuffer, 0, 4);
  edges.set([0, 1, 1, 1]);
  const result = await window.FrameLabCompute.projectConstraints(nodes, edges, 1, { transferOwnership: true });
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0].message.nodes, nodeBuffer, 'oversized scratch capacity is compacted before transfer');
  assert.notEqual(requests[0].message.edges, edgeBuffer, 'oversized edge capacity is compacted before transfer');
  assert.equal(requests[0].message.nodes.byteLength, 80);
  assert.equal(requests[0].message.edges.byteLength, 32);
  assert.ok(requests[0].transfer.includes(requests[0].message.nodes) && requests[0].transfer.includes(requests[0].message.edges));
  assert.equal(requests[0].message.nodeLength, 10);
  assert.equal(requests[0].message.edgeLength, 4);
  assert.equal(result.data.length, 10);
  assert.equal(result.edges.length, 4);
  assert.ok(Math.abs(result.data[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(result.data[5] - 1.5) < 1e-9);

  const exactNodes = new Float64Array([0, 0, 0, 0, 1, 2, 0, 2, 0, 1]);
  const exactEdges = new Float64Array([0, 1, 1, 1]);
  const exactNodeBuffer = exactNodes.buffer, exactEdgeBuffer = exactEdges.buffer;
  const exactResult = await window.FrameLabCompute.projectConstraints(exactNodes, exactEdges, 1, { transferOwnership: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].message.nodes, exactNodeBuffer, 'exact-sized node buffers transfer without a duplicate');
  assert.equal(requests[1].message.edges, exactEdgeBuffer, 'exact-sized edge buffers transfer without a duplicate');
  assert.equal(exactResult.data.length, 10);
  assert.equal(exactResult.edges.length, 4);
});


test('debris-to-structure spatial index keeps nearby contacts and excludes remote members', () => {
  const main = read('js/main.js');
  const start = main.indexOf('function buildDebrisMemberCollisionIndex()');
  const end = main.indexOf('async function updateDebris(dt)', start);
  assert.ok(start >= 0 && end > start, 'collision index helpers are defined before debris integration');
  const nearColumn = { id: 'near-column', nodeA: 'c0', nodeB: 'c1', e: { kind: 'column', failed: false, snapped: false, integrity: 1 } };
  const nearBeam = { id: 'near-beam', nodeA: 'c1', nodeB: 'c2', e: { kind: 'beam', failed: false, snapped: false, integrity: 1 } };
  const remoteColumn = { id: 'remote-column', nodeA: 'r0', nodeB: 'r1', e: { kind: 'column', failed: false, snapped: false, integrity: 1 } };
  const failedBeam = { id: 'failed-beam', nodeA: 'c1', nodeB: 'c2', e: { kind: 'beam', failed: true, snapped: false, integrity: 0 } };
  const sim = {
    nodes: {
      c0: { position: { x: 1, y: 0 } },
      c1: { position: { x: 1, y: 3.15 } },
      c2: { position: { x: 3, y: 3.15 } },
      r0: { position: { x: 80, y: 0 } },
      r1: { position: { x: 80, y: 3.15 } }
    },
    memberLinks: [nearColumn, nearBeam, remoteColumn, failedBeam]
  };
  const context = { sim, STORY_HEIGHT: 3.15, FLOOR_THICKNESS: 0.12, Map, Set, Math };
  vm.runInNewContext(
    main.slice(start, end) + '\nthis.buildIndex = buildDebrisMemberCollisionIndex; this.query = queryDebrisMemberCollisionLinks;',
    context,
    { filename: 'debris-collision-index.test.js' }
  );
  const index = context.buildIndex();
  const columns = context.query(index.columns, index.cellSize, 0.5, 1.5, 0.7, 2.1);
  const floors = context.query(index.floors, index.cellSize, 1.4, 2.6, 2.9, 3.4);
  assert.deepEqual(Array.from(columns, link => link.id), ['near-column']);
  assert.deepEqual(Array.from(floors, link => link.id), ['near-beam']);
});


test('mock WebGPU integration and diagnostics reuse GPU buffers without changing physics results', async () => {
  const source = read('js/compute-backends.js');
  const status = { textContent: '' };
  const createdBuffers = [];
  let submissions = 0;
  const bufferUsage = { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8, MAP_READ: 16 };
  const mapMode = { READ: 1 };

  const device = {
    limits: { maxBufferSize: 1 << 20, maxStorageBufferBindingSize: 1 << 20 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) {
      const buffer = {
        size, usage, storage: new ArrayBuffer(size), mapped: false, destroyed: false,
        destroy() { this.destroyed = true; },
        async mapAsync(_mode, offset = 0, length = size - offset) {
          if (this.destroyed || offset + length > this.size) throw new Error('invalid map range');
          this.mapped = true;
        },
        getMappedRange(offset = 0, length = size - offset) {
          if (!this.mapped || this.destroyed) throw new Error('buffer is not mapped');
          return this.storage.slice(offset, offset + length);
        },
        unmap() { this.mapped = false; }
      };
      createdBuffers.push(buffer);
      return buffer;
    },
    createShaderModule({ code }) { return { code }; },
    async createComputePipelineAsync({ compute }) {
      return { code: compute.module.code, getBindGroupLayout() { return {}; } };
    },
    createBindGroup({ entries }) {
      return { entries: Object.fromEntries(entries.map(entry => [entry.binding, entry.resource.buffer])) };
    },
    createCommandEncoder() {
      const encoder = { pass: null, copies: [] };
      encoder.beginComputePass = () => {
        const pass = { pipeline: null, bindGroup: null,
          setPipeline(pipeline) { this.pipeline = pipeline; },
          setBindGroup(_index, bindGroup) { this.bindGroup = bindGroup; },
          dispatchWorkgroups() {},
          end() {}
        };
        encoder.pass = pass;
        return pass;
      };
      encoder.copyBufferToBuffer = (from, fromOffset, to, toOffset, size) => {
        encoder.copies.push({ from, fromOffset, to, toOffset, size });
      };
      encoder.finish = () => encoder;
      return encoder;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        const src = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        new Uint8Array(buffer.storage, offset, src.byteLength).set(src);
      },
      submit(commands) {
        submissions++;
        for (const command of commands) {
          const pass = command.pass;
          if (pass) {
            const bind = pass.bindGroup.entries, code = pass.pipeline.code;
            if (code.includes('const STRIDE: u32 = 13u')) {
              const bodies = new Float32Array(bind[0].storage), params = new DataView(bind[1].storage);
              const count = params.getUint32(0, true), dt = params.getFloat32(4, true);
              const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
              for (let i = 0; i < count; i++) {
                const b = i * 13, maxVX = Math.max(0, bodies[b + 10]), maxVY = Math.max(0, bodies[b + 11]), maxOmega = Math.max(0, bodies[b + 12]);
                const vx = clamp(bodies[b + 2] + bodies[b + 4] * dt, -maxVX, maxVX);
                const vy = clamp(bodies[b + 3] + bodies[b + 5] * dt, -maxVY, maxVY);
                const omegaStep = clamp(bodies[b + 7] + bodies[b + 8] * dt, -maxOmega, maxOmega);
                const omega = omegaStep * clamp(bodies[b + 9], 0, 1);
                bodies[b + 2] = vx; bodies[b + 3] = vy;
                bodies[b] += vx * dt; bodies[b + 1] += vy * dt;
                bodies[b + 7] = omega; bodies[b + 6] += omega * dt;
              }
            } else {
              const input = new Float32Array(bind[0].storage), ratios = new Float32Array(bind[1].storage);
              const count = new Uint32Array(bind[2].storage)[0];
              for (let i = 0; i < count; i++) ratios[i] = Math.max(input[i * 2], 0) / Math.max(input[i * 2 + 1], 0.01);
            }
          }
          for (const copy of command.copies) {
            new Uint8Array(copy.to.storage, copy.toOffset, copy.size)
              .set(new Uint8Array(copy.from.storage, copy.fromOffset, copy.size));
          }
        }
      }
    }
  };
  const adapter = { async requestDevice() { return device; } };
  const window = {};
  const document = {
    baseURI: 'https://example.test/framelabs/',
    currentScript: { src: 'https://example.test/framelabs/js/compute-backends.js' },
    getElementById: (id) => id === 'computeMetric' ? status : null
  };
  const navigator = { gpu: { async requestAdapter() { return adapter; } } };
  vm.runInNewContext(source, {
    window, document, navigator, URL, Float32Array, Float64Array, Uint32Array, ArrayBuffer, DataView,
    Math, Number, Map, Set, performance, GPUBufferUsage: bufferUsage, GPUMapMode: mapMode
  }, { filename: 'compute-backends-mock-gpu.test.js' });
  window.FrameLabCompute.setMode('gpu');

  const original = new Float32Array([1, 2, 1, -2, 2, 10, 0.5, 1, 2, 0.5, 3, 4, 5]);
  const first = await window.FrameLabCompute.integrateBodies(new Float32Array(original), 0.05);
  assert.equal(first.backend, 'WebGPU physics');
  assert.ok(Math.abs(first.data[0] - 1.055) < 1e-6);
  const afterFirstIntegration = createdBuffers.length;
  const second = await window.FrameLabCompute.integrateBodies(new Float32Array(original), 0.05);
  assert.equal(second.backend, 'WebGPU physics');
  assert.equal(createdBuffers.length, afterFirstIntegration, 'body storage/uniform/readback buffers are reused');

  const demand = new Float32Array(2048).fill(2), capacity = new Float32Array(2048).fill(1);
  const firstScan = await window.FrameLabCompute.scan(demand, capacity);
  assert.equal(firstScan.backend, 'WebGPU compute');
  assert.equal(firstScan.maxUtil, 2);
  const afterFirstScan = createdBuffers.length;
  const secondScan = await window.FrameLabCompute.scan(demand, capacity);
  assert.equal(secondScan.backend, 'WebGPU compute');
  assert.equal(secondScan.meanUtil, 2);
  assert.equal(createdBuffers.length, afterFirstScan, 'diagnostic input/output/readback/uniform buffers are reused');
  const diagnostics = window.FrameLabCompute.getDiagnostics();
  assert.equal(diagnostics.gpuIntegrationCalls, 2);
  assert.ok(diagnostics.transferredBytes >= 0);
  assert.ok(submissions >= 4, 'each GPU call submits a compute pass');
});
