/* FrameLab supplemental parallel compute.
   WebGPU is opportunistic for large numeric snapshots; the CPU worker is the
   default for normal structures. Neither backend replaces the authoritative
   structural solver in main.js. */
(() => {
  'use strict';

  const scriptURL = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : new URL('./js/compute-backends.js', document.baseURI).href;
  const workerURL = new URL('./compute-worker.js', scriptURL);
  const GPU_THRESHOLD = 2048;
  const GPU_BENCHMARK_COUNTS = [256, 1024, 4096];
  let autoPreferGPU = false;
  let autoGPUThreshold = Infinity;
  let gpuBodyLimitBytes = Infinity;
  const BODY_STRIDE = 13; // x,y,vx,vy,ax,ay,angle,omega,alpha,angular damping,max vx,max vy,max omega

  let worker = null;
  let backend = 'Main-thread fallback';
  let gpuState = 'not initialized';
  let gpuDevice = null;
  let gpuPipeline = null;
  let gpuIntegratePipeline = null;
  let physicsMode = 'auto';
  let physicsBackend = 'CPU worker';
  let gpuInitPromise = null;
  let sequence = 0;
  const pending = new Map();
  const gpuBuffers = { body: {}, scan: {} };
  const computeStats = {
    gpuIntegrationCalls: 0, workerIntegrationCalls: 0, wasmIntegrationCalls: 0,
    mainThreadIntegrationCalls: 0, workerConstraintCalls: 0, wasmConstraintCalls: 0,
    wasmDebrisBatches: 0, workerFailures: 0, gpuFallbacks: 0,
    transferredBytes: 0, lastIntegrationBackend: 'not started'
  };
  let runtimeStatusTimer = null;
  let runtimeStatusPending = '';

  const statusEl = () => document.getElementById('computeMetric');
  function setStatus(text) {
    if (runtimeStatusTimer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(runtimeStatusTimer);
    }
    runtimeStatusTimer = null;
    runtimeStatusPending = '';
    const el = statusEl();
    const value = String(text ?? '');
    if (el && el.textContent !== value) el.textContent = value;
  }
  // Hot physics paths update their internal backend state every substep, but
  // touching the DOM several hundred times per second adds needless main-thread
  // work. Coalesce status-only UI updates to at most four times per second.
  function setRuntimeStatus(text) {
    runtimeStatusPending = String(text ?? '');
    if (runtimeStatusTimer !== null) return;
    if (typeof window.setTimeout !== 'function') {
      setStatus(runtimeStatusPending);
      return;
    }
    runtimeStatusTimer = window.setTimeout(() => {
      runtimeStatusTimer = null;
      const value = runtimeStatusPending;
      runtimeStatusPending = '';
      const el = statusEl();
      if (el && value && el.textContent !== value) el.textContent = value;
    }, 250);
  }
  class GPUBufferLimitError extends RangeError {
    constructor(message) { super(message); this.name = 'GPUBufferLimitError'; }
  }
  function destroyBufferPool(pool) {
    for (const key of Object.keys(pool)) {
      if (key.endsWith('Capacity')) continue;
      try { pool[key]?.destroy?.(); } catch (_) {}
      pool[key] = null;
    }
    for (const key of Object.keys(pool)) if (key.endsWith('Capacity')) pool[key] = 0;
  }
  function clearGPUBufferPools() {
    destroyBufferPool(gpuBuffers.body);
    destroyBufferPool(gpuBuffers.scan);
  }
  function ensureGPUBuffer(device, pool, key, requiredSize, usage, maxSize = Infinity) {
    if (!Number.isSafeInteger(requiredSize) || requiredSize <= 0) {
      throw new RangeError('GPU buffer size must be a positive integer.');
    }
    const hardLimit = Math.min(
      Number(device.limits?.maxBufferSize) || Infinity,
      Number(maxSize) || Infinity
    );
    if (requiredSize > hardLimit) {
      throw new GPUBufferLimitError(`Requested GPU buffer (${requiredSize} bytes) exceeds this adapter's limit (${hardLimit} bytes).`);
    }
    const capacityKey = `${key}Capacity`;
    if (pool[key] && (pool[capacityKey] || 0) >= requiredSize) return pool[key];
    try { pool[key]?.destroy?.(); } catch (_) {}
    let capacity = Math.max(256, 2 ** Math.ceil(Math.log2(requiredSize)));
    if (capacity > hardLimit) capacity = requiredSize;
    if (capacity % 4) capacity = Math.ceil(capacity / 4) * 4;
    if (capacity > hardLimit) capacity = requiredSize;
    const buffer = device.createBuffer({ size: capacity, usage });
    pool[key] = buffer;
    pool[capacityKey] = capacity;
    return buffer;
  }
  function finiteNonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  function summarizeRatios(ratios, source, count = ratios.length) {
    let maxUtil = 0, sumUtil = 0, overloaded = 0;
    for (let i = 0; i < ratios.length; i++) {
      const value = Number.isFinite(ratios[i]) ? Math.max(0, ratios[i]) : 0;
      if (value > maxUtil) maxUtil = value;
      sumUtil += value;
      if (value >= 1) overloaded++;
    }
    return {
      backend: source,
      count,
      maxUtil,
      meanUtil: ratios.length ? sumUtil / ratios.length : 0,
      overloaded
    };
  }
  function summarizeOnMain(demands, capacities) {
    let maxUtil = 0, sumUtil = 0, overloaded = 0;
    for (let i = 0; i < demands.length; i++) {
      const demand = finiteNonNegative(demands[i]);
      const capacity = Math.max(0.01, finiteNonNegative(capacities[i]));
      const ratio = demand / capacity;
      if (ratio > maxUtil) maxUtil = ratio;
      sumUtil += ratio;
      if (ratio >= 1) overloaded++;
    }
    return {
      backend: 'Main-thread fallback',
      count: demands.length,
      maxUtil,
      meanUtil: demands.length ? sumUtil / demands.length : 0,
      overloaded
    };
  }

  function failPending(error) {
    for (const [id, item] of pending) {
      pending.delete(id);
      item.reject(error instanceof Error ? error : new Error(String(error || 'CPU worker failed')));
    }
  }
  function disableWorker(reason) {
    if (worker) {
      computeStats.workerFailures++;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
    failPending(reason || new Error('CPU worker unavailable'));
    backend = 'Main-thread fallback';
    setStatus(backend);
  }

  function initWorker() {
    if (!('Worker' in window)) return;
    try {
      worker = new Worker(workerURL.href);
      worker.onmessage = ({ data }) => {
        if (!data || !Number.isInteger(data.id)) return;
        const item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id);
        if (data.error) item.reject(new Error(data.error));
        else item.resolve(data);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        disableWorker(new Error(event.message || 'CPU worker crashed'));
      };
      worker.onmessageerror = () => disableWorker(new Error('CPU worker sent an unreadable message'));
      backend = 'Web Worker (CPU)';
    } catch (_) {
      worker = null;
      backend = 'Main-thread fallback';
    }
  }

  async function initGPU() {
    if (gpuDevice && gpuPipeline) return;
    if (gpuInitPromise) return gpuInitPromise;
    gpuInitPromise = (async () => {
      if (!navigator.gpu) throw new Error('WebGPU unavailable');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No compatible GPU adapter');
      const device = await adapter.requestDevice();
      const shader = device.createShaderModule({ code: `
        struct Entry { demand: f32, capacity: f32 };
        @group(0) @binding(0) var<storage, read> entries: array<Entry>;
        @group(0) @binding(1) var<storage, read_write> ratios: array<f32>;
        @group(0) @binding(2) var<uniform> count: u32;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let i = gid.x;
          if (i >= count) { return; }
          let cap = max(entries[i].capacity, 0.01);
          ratios[i] = max(entries[i].demand, 0.0) / cap;
        }
      ` });
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: shader, entryPoint: 'main' }
      });
      const integrationShader = device.createShaderModule({ code: `
        struct Params { count: u32, dt: f32, pad0: u32, pad1: u32 };
        @group(0) @binding(0) var<storage, read_write> bodies: array<f32>;
        @group(0) @binding(1) var<uniform> params: Params;
        const STRIDE: u32 = 13u;
        fn clampVelocity(v: f32, limit: f32) -> f32 { return clamp(v, -max(limit, 0.0), max(limit, 0.0)); }
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let i = gid.x;
          if (i >= params.count) { return; }
          let b = i * STRIDE;
          let dt = clamp(params.dt, 0.0, 0.05);
          var vx = clampVelocity(bodies[b+2u] + bodies[b+4u] * dt, bodies[b+10u]);
          var vy = clampVelocity(bodies[b+3u] + bodies[b+5u] * dt, bodies[b+11u]);
          var omega = clampVelocity(bodies[b+7u] + bodies[b+8u] * dt, bodies[b+12u]);
          omega = omega * clamp(bodies[b+9u], 0.0, 1.0);
          bodies[b+2u] = vx;
          bodies[b+3u] = vy;
          bodies[b+0u] = bodies[b+0u] + vx * dt;
          bodies[b+1u] = bodies[b+1u] + vy * dt;
          bodies[b+7u] = omega;
          bodies[b+6u] = bodies[b+6u] + omega * dt;
        }
      ` });
      const integrationPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: integrationShader, entryPoint: 'main' }
      });
      gpuDevice = device;
      gpuPipeline = pipeline;
      gpuIntegratePipeline = integrationPipeline;
      gpuState = 'ready';
      device.lost.then((info) => {
        if (gpuDevice !== device) return;
        gpuDevice = null;
        gpuPipeline = null;
        gpuIntegratePipeline = null;
        gpuInitPromise = null;
        autoPreferGPU = false;
        autoGPUThreshold = Infinity;
        clearGPUBufferPools();
        gpuState = `lost${info && info.message ? `: ${info.message}` : ''}`;
        backend = worker ? 'Web Worker (CPU)' : 'Main-thread fallback';
        setStatus(`${backend} · GPU unavailable`);
      }).catch(() => {});
    })().catch((error) => {
      gpuState = 'unavailable';
      gpuDevice = null;
      gpuPipeline = null;
      gpuIntegratePipeline = null;
      gpuInitPromise = null;
      autoPreferGPU = false;
      autoGPUThreshold = Infinity;
      clearGPUBufferPools();
      throw error;
    });
    return gpuInitPromise;
  }

  async function scanGPU(demands, capacities) {
    await initGPU();
    const device = gpuDevice, pipeline = gpuPipeline;
    if (!device || !pipeline) throw new Error('GPU not ready');
    const count = demands.length;
    if (count === 0) return { backend: 'WebGPU compute', count: 0, maxUtil: 0, meanUtil: 0, overloaded: 0 };

    const packed = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      packed[i * 2] = finiteNonNegative(demands[i]);
      packed[i * 2 + 1] = Math.max(0.01, finiteNonNegative(capacities[i]));
    }

    const inputBytes = packed.byteLength;
    const outputSize = count * Float32Array.BYTES_PER_ELEMENT;
    let mapped = false;
    const input = ensureGPUBuffer(device, gpuBuffers.scan, 'input', inputBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, device.limits.maxStorageBufferBindingSize);
    const output = ensureGPUBuffer(device, gpuBuffers.scan, 'output', outputSize,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, device.limits.maxStorageBufferBindingSize);
    const readback = ensureGPUBuffer(device, gpuBuffers.scan, 'readback', outputSize,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const uniform = ensureGPUBuffer(device, gpuBuffers.scan, 'uniform', 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    try {
      device.queue.writeBuffer(input, 0, packed);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([count]));
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input, size: inputBytes } },
          { binding: 1, resource: { buffer: output, size: outputSize } },
          { binding: 2, resource: { buffer: uniform, size: 4 } }
        ]
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, outputSize);
      mapped = true;
      const ratios = new Float32Array(readback.getMappedRange(0, outputSize).slice(0));
      return summarizeRatios(ratios, 'WebGPU compute', count);
    } finally {
      if (mapped) {
        try { readback.unmap(); } catch (_) {}
      }
      // Keep GPU buffers around between scans; destroy/replace only on growth,
      // device loss, or a genuine backend failure.
    }
  }

  function integrateCPU(packed, dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    for (let i = 0; i < packed.length / BODY_STRIDE; i++) {
      const b = i * BODY_STRIDE;
      const maxVX = Math.max(0, Number(packed[b + 10]) || 0);
      const maxVY = Math.max(0, Number(packed[b + 11]) || 0);
      const maxOmega = Math.max(0, Number(packed[b + 12]) || 0);
      const vx = Math.max(-maxVX, Math.min(maxVX, (Number(packed[b + 2]) || 0) + (Number(packed[b + 4]) || 0) * step));
      const vy = Math.max(-maxVY, Math.min(maxVY, (Number(packed[b + 3]) || 0) + (Number(packed[b + 5]) || 0) * step));
      const damping = Math.max(0, Math.min(1, Number(packed[b + 9]) || 0));
      const omegaStep = Math.max(-maxOmega, Math.min(maxOmega, (Number(packed[b + 7]) || 0) + (Number(packed[b + 8]) || 0) * step));
      const omega = omegaStep * damping;
      packed[b + 2] = vx;
      packed[b + 3] = vy;
      packed[b] += vx * step;
      packed[b + 1] += vy * step;
      packed[b + 7] = omega;
      packed[b + 6] += omega * step;
    }
    return packed;
  }

  async function integrateGPU(packed, dt) {
    await initGPU();
    const device = gpuDevice, pipeline = gpuIntegratePipeline;
    if (!device || !pipeline) throw new Error('WebGPU physics pipeline is not ready');
    const count = packed.length / BODY_STRIDE;
    if (!count) return packed;
    const bytes = packed.byteLength;
    const maxStateBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (bytes > maxStateBytes) {
      throw new GPUBufferLimitError("Physics batch exceeds this GPU adapter's storage-buffer limit");
    }
    let mapped = false;
    // Reuse storage/uniform/readback buffers across fixed 120 Hz steps. Creating
    // and destroying three GPU buffers every call was needless allocator churn.
    const state = ensureGPUBuffer(device, gpuBuffers.body, 'state', bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, maxStateBytes);
    const uniform = ensureGPUBuffer(device, gpuBuffers.body, 'uniform', 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const readback = ensureGPUBuffer(device, gpuBuffers.body, 'readback', bytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    try {
      device.queue.writeBuffer(state, 0, packed);
      const params = new ArrayBuffer(16), view = new DataView(params);
      view.setUint32(0, count, true);
      view.setFloat32(4, Math.max(0, Math.min(0.05, Number(dt) || 0)), true);
      device.queue.writeBuffer(uniform, 0, params);
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: state, size: bytes } },
          { binding: 1, resource: { buffer: uniform, size: 16 } }
        ]
      });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
      encoder.copyBufferToBuffer(state, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, bytes);
      mapped = true;
      return new Float32Array(readback.getMappedRange(0, bytes).slice(0));
    } finally {
      if (mapped) { try { readback.unmap(); } catch (_) {} }
      // Buffers are intentionally retained for the next physics substep.
    }
  }

  function projectConstraintsCPU(nodes, edges, iterations) {
    const nodeStride = 5, edgeStride = 4, count = nodes.length / nodeStride;
    const loops = Math.max(1, Math.min(32, Math.trunc(Number(iterations) || 1)));
    for (let iteration = 0; iteration < loops; iteration++) {
      // Gauss-Seidel position projection: preserving edge order matches the existing solver's convergence behavior.
      for (let e = 0; e < edges.length / edgeStride; e++) {
        const q = e * edgeStride, ai = Math.trunc(edges[q]), bi = Math.trunc(edges[q + 1]);
        if (ai < 0 || bi < 0 || ai >= count || bi >= count) continue;
        const a = ai * nodeStride, b = bi * nodeStride;
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
    // Remove along-member relative velocity after the position passes, matching FrameLab's original projection.
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
    return nodes;
  }

  function projectConstraintsWorker(nodes, edges, iterations) {
    if (!worker) return Promise.resolve({ data: projectConstraintsCPU(nodes, edges, iterations), backend: 'Main-thread CPU fallback' });
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (message) => {
        if (!message || !(message.data instanceof ArrayBuffer)) { reject(new Error('CPU worker returned an invalid constraint result')); return; }
        const result = new Float64Array(message.data, 0,
          Number.isInteger(message.length) ? message.length : message.data.byteLength / Float64Array.BYTES_PER_ELEMENT);
        computeStats.workerConstraintCalls++;
        if (String(message.backend || '').includes('C++ WebAssembly')) computeStats.wasmConstraintCalls++;
        resolve({ data: result, backend: message.backend || 'CPU worker constraints' });
      }, reject });
      try {
        const nodeCopy = new Float64Array(nodes), edgeCopy = new Float64Array(edges);
        computeStats.transferredBytes += nodeCopy.byteLength + edgeCopy.byteLength;
        worker.postMessage({
          id, type: 'projectConstraints', nodes: nodeCopy.buffer, edges: edgeCopy.buffer,
          nodeLength: nodeCopy.length, edgeLength: edgeCopy.length, iterations
        }, [nodeCopy.buffer, edgeCopy.buffer]);
      } catch (error) { pending.delete(id); reject(error); }
    }).catch((error) => {
      if (worker) disableWorker(error);
      return { data: projectConstraintsCPU(new Float64Array(nodes), new Float64Array(edges), iterations), backend: 'Main-thread CPU fallback' };
    });
  }


  async function resolveDebrisPairs(bodies, pairs, moisture = 0) {
    if (!(bodies instanceof Float64Array) || bodies.length % 19 !== 0 ||
        !(pairs instanceof Uint32Array) || pairs.length % 2 !== 0) {
      throw new TypeError('Debris collision solve requires 19-value Float64 bodies and uint32 index pairs.');
    }
    if (!pairs.length || physicsMode === 'main' || !worker) return null;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (message) => {
          if (!message || !String(message.backend || '').includes('C++ WebAssembly') ||
              !(message.bodies instanceof ArrayBuffer) || !(message.events instanceof ArrayBuffer)) {
            resolve(null);
            return;
          }
          const resultBodies = new Float64Array(message.bodies,
            0, Number.isInteger(message.bodyLength) ? message.bodyLength : message.bodies.byteLength / Float64Array.BYTES_PER_ELEMENT);
          const events = new Float64Array(message.events,
            0, Number.isInteger(message.eventLength) ? message.eventLength : message.events.byteLength / Float64Array.BYTES_PER_ELEMENT);
          if (resultBodies.length !== bodies.length || events.length !== pairs.length * 2) {
            resolve(null);
            return;
          }
          physicsBackend = message.backend;
          backend = message.backend;
          computeStats.wasmDebrisBatches++;
          computeStats.transferredBytes += message.bodies.byteLength + message.events.byteLength;
          setRuntimeStatus(message.backend + ' · ' + (pairs.length / 2) + ' debris pairs');
          resolve({ backend: message.backend, bodies: resultBodies, events });
        },
        reject
      });
      try {
        const bodyCopy = new Float64Array(bodies), pairCopy = new Uint32Array(pairs);
        computeStats.transferredBytes += bodyCopy.byteLength + pairCopy.byteLength;
        worker.postMessage({
          id, type: 'resolveDebrisPairs', bodies: bodyCopy.buffer,
          pairs: pairCopy.buffer, moisture: Number(moisture) || 0
        }, [bodyCopy.buffer, pairCopy.buffer]);
      } catch (error) {
        pending.delete(id);
        resolve(null);
      }
    }).catch((error) => {
      if (worker) disableWorker(error);
      return null;
    });
  }

  async function projectConstraints(nodes, edges, iterations) {
    if (!(nodes instanceof Float64Array) || nodes.length % 5 !== 0 || !(edges instanceof Float64Array) || edges.length % 4 !== 0) {
      throw new TypeError('Constraint projection requires Float64 node state (5 values per node) and edge state (4 values per link).');
    }
    for (let i = 0; i < nodes.length; i++) if (!Number.isFinite(nodes[i])) nodes[i] = 0;
    for (let i = 0; i < edges.length; i++) if (!Number.isFinite(edges[i])) edges[i] = 0;
    const hadWebGPU = physicsBackend.includes('WebGPU');
    const workerResult = physicsMode === 'main'
      ? { data: projectConstraintsCPU(new Float64Array(nodes), new Float64Array(edges), iterations), backend: 'Main-thread CPU' }
      : await projectConstraintsWorker(nodes, edges, iterations);
    if (physicsMode === 'main') physicsBackend = 'Main-thread CPU';
    else if (!worker) physicsBackend = 'Main-thread CPU fallback';
    else if (hadWebGPU) physicsBackend = workerResult.backend.includes('C++ WebAssembly')
      ? 'WebGPU integration + C++ WebAssembly constraints'
      : 'WebGPU integration + CPU worker constraints';
    else if (workerResult.backend.includes('C++ WebAssembly')) physicsBackend = 'C++ WebAssembly integration + constraints (CPU worker)';
    else physicsBackend = 'CPU worker integration + CPU constraints';
    backend = physicsBackend;
    setRuntimeStatus(physicsBackend);
    return workerResult.data;
  }

  function integrateWorker(packed, dt, transferOwnership = false) {
    if (!worker) {
      computeStats.mainThreadIntegrationCalls++;
      return Promise.resolve({ data: integrateCPU(packed, dt), backend: 'Main-thread CPU fallback' });
    }
    const id = ++sequence;
    const canTransfer = transferOwnership && packed.byteOffset === 0;
    const payload = canTransfer ? packed : new Float32Array(packed);
    const activeLength = payload.length;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (message) => {
        if (!message || !(message.data instanceof ArrayBuffer || ArrayBuffer.isView(message.data))) {
          reject(new Error('CPU worker returned an invalid physics result')); return;
        }
        let data;
        if (message.data instanceof ArrayBuffer) {
          const length = Number.isInteger(message.length) ? message.length : message.data.byteLength / Float32Array.BYTES_PER_ELEMENT;
          if (length < 0 || length > message.data.byteLength / Float32Array.BYTES_PER_ELEMENT || length % BODY_STRIDE !== 0) {
            reject(new Error('CPU worker returned an invalid active body length')); return;
          }
          data = new Float32Array(message.data, 0, length);
          computeStats.transferredBytes += message.data.byteLength;
        } else {
          data = new Float32Array(message.data);
        }
        if (data.length !== activeLength) {
          reject(new Error('CPU worker returned an unexpected body count')); return;
        }
        computeStats.workerIntegrationCalls++;
        if (String(message.backend || '').includes('C++ WebAssembly')) computeStats.wasmIntegrationCalls++;
        computeStats.lastIntegrationBackend = message.backend || 'CPU worker physics';
        resolve({ data, backend: message.backend || 'CPU worker physics' });
      }, reject });
      try {
        if (canTransfer) computeStats.transferredBytes += payload.buffer.byteLength;
        worker.postMessage({
          id, type: 'integrateBodies', dt, length: activeLength, data: payload.buffer
        }, [payload.buffer]);
      } catch (error) { pending.delete(id); reject(error); }
    }).catch((error) => {
      if (worker) disableWorker(error);
      // A transferred buffer is no longer readable after a worker crash. The caller
      // can repack state from its authoritative objects and ask the CPU fallback to retry.
      if (canTransfer) return { data: null, backend: 'CPU worker lost; repack required' };
      computeStats.mainThreadIntegrationCalls++;
      computeStats.lastIntegrationBackend = 'Main-thread CPU fallback';
      return { data: integrateCPU(new Float32Array(packed), dt), backend: 'Main-thread CPU fallback' };
    });
  }

  async function integrateBodies(packed, dt, options = {}) {
    if (!(packed instanceof Float32Array) || packed.length % BODY_STRIDE !== 0) {
      throw new TypeError(`Physics integration requires a Float32Array with ${BODY_STRIDE} values per body.`);
    }
    if (!Number.isFinite(Number(dt)) || dt < 0 || dt > 0.05) throw new RangeError('Physics dt must be between 0 and 0.05 seconds.');
    if (packed.length === 0) return { data: packed, backend: 'No dynamic bodies' };
    for (let i = 0; i < packed.length; i++) if (!Number.isFinite(packed[i])) packed[i] = 0;
    const transferOwnership = options && options.transferOwnership === true;
    const count = packed.length / BODY_STRIDE;
    const useGPU = physicsMode === 'gpu' ||
      (physicsMode === 'auto' && autoPreferGPU && count >= autoGPUThreshold &&
       packed.byteLength <= gpuBodyLimitBytes && navigator.gpu && gpuState !== 'unavailable');
    if (useGPU && navigator.gpu && gpuState !== 'unavailable') {
      try {
        const result = await integrateGPU(packed, dt);
        computeStats.gpuIntegrationCalls++;
        computeStats.lastIntegrationBackend = 'WebGPU physics';
        physicsBackend = 'WebGPU physics';
        backend = physicsBackend;
        setRuntimeStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
        return { data: result, backend: physicsBackend };
      } catch (error) {
        computeStats.gpuFallbacks++;
        if (error instanceof GPUBufferLimitError) {
          gpuBodyLimitBytes = Math.min(gpuBodyLimitBytes, Math.max(0, packed.byteLength - 4));
          setRuntimeStatus('WebGPU batch exceeds adapter limit; using CPU for this batch');
        } else {
          gpuState = 'unavailable'; gpuDevice = null; gpuPipeline = null; gpuIntegratePipeline = null; gpuInitPromise = null;
          autoPreferGPU = false; autoGPUThreshold = Infinity; clearGPUBufferPools();
          if (physicsMode === 'gpu') setStatus(`WebGPU failed; using CPU · ${error?.message || 'GPU error'}`);
        }
      }
    }
    if (physicsMode === 'main') {
      computeStats.mainThreadIntegrationCalls++;
      const result = integrateCPU(new Float32Array(packed), dt);
      computeStats.lastIntegrationBackend = 'Main-thread CPU';
      physicsBackend = 'Main-thread CPU'; backend = physicsBackend;
      setRuntimeStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
      return { data: result, backend: physicsBackend };
    }
    const workerResult = await integrateWorker(packed, dt, transferOwnership);
    if (!workerResult.data) {
      return { data: null, backend: workerResult.backend, retryRequired: true };
    }
    const result = workerResult.data;
    physicsBackend = workerResult.backend;
    backend = physicsBackend;
    setRuntimeStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
    return { data: result, backend: physicsBackend };
  }

  async function benchmarkPhysicsBackends() {
    if (!navigator.gpu) {
      autoPreferGPU = false;
      autoGPUThreshold = Infinity;
      return { available: false, cpuAverageMs: null, gpuAverageMs: null, preferGPU: false,
        autoGPUThreshold: null, reason: 'WebGPU unavailable; Auto selects CPU worker' };
    }
    const dt = 1 / 120;
    const measurements = [];
    function makeBodies(count) {
      const packed = new Float32Array(count * BODY_STRIDE);
      for (let i = 0; i < count; i++) {
        const b = i * BODY_STRIDE;
        packed[b] = (i % 37) * 0.03; packed[b + 1] = (i % 29) * 0.02;
        packed[b + 2] = ((i % 7) - 3) * 0.01; packed[b + 3] = ((i % 11) - 5) * 0.01;
        packed[b + 4] = ((i % 13) - 6) * 0.2; packed[b + 5] = -9.81;
        packed[b + 6] = (i % 17) * 0.01; packed[b + 7] = ((i % 5) - 2) * 0.02;
        packed[b + 8] = 0.1; packed[b + 9] = 0.998;
        packed[b + 10] = 5; packed[b + 11] = 15; packed[b + 12] = 3.4;
      }
      return packed;
    }
    function median(values) {
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    }
    try {
      // A GPU win at one size is not enough to justify routing every batch there.
      for (const count of GPU_BENCHMARK_COUNTS) {
        const packed = makeBodies(count);
        await integrateWorker(new Float32Array(packed), dt);
        await integrateGPU(new Float32Array(packed), dt);
        const cpuSamples = [], gpuSamples = [];
        for (let run = 0; run < 3; run++) {
          const measureCPU = async () => {
            const start = performance.now();
            await integrateWorker(new Float32Array(packed), dt);
            cpuSamples.push(Math.max(0.01, performance.now() - start));
          };
          const measureGPU = async () => {
            const start = performance.now();
            await integrateGPU(new Float32Array(packed), dt);
            gpuSamples.push(Math.max(0.01, performance.now() - start));
          };
          // Alternate timing order to reduce systematic measurement bias.
          if (run % 2 === 0) { await measureCPU(); await measureGPU(); }
          else { await measureGPU(); await measureCPU(); }
        }
        const cpuMedianMs = median(cpuSamples), gpuMedianMs = median(gpuSamples);
        measurements.push({
          count, cpuAverageMs: cpuMedianMs, gpuAverageMs: gpuMedianMs,
          preferGPU: gpuMedianMs < cpuMedianMs * 0.85
        });
      }
      // Require a sustained 15% GPU win at this size and every larger tested size.
      let crossoverIndex = -1;
      for (let i = 0; i < measurements.length; i++) {
        if (measurements[i].preferGPU && measurements.slice(i).every(sample => sample.preferGPU)) {
          crossoverIndex = i;
          break;
        }
      }
      autoGPUThreshold = crossoverIndex < 0 ? Infinity : measurements[crossoverIndex].count;
      autoPreferGPU = Number.isFinite(autoGPUThreshold);
      const reference = measurements.find(sample => sample.count === 1024) || measurements[measurements.length - 1];
      return {
        available: true, count: reference.count,
        cpuAverageMs: reference.cpuAverageMs, gpuAverageMs: reference.gpuAverageMs,
        preferGPU: autoPreferGPU, autoGPUThreshold: Number.isFinite(autoGPUThreshold) ? autoGPUThreshold : null,
        measurements,
        reason: autoPreferGPU
          ? `WebGPU repeatedly beats the CPU worker by at least 15% from ${autoGPUThreshold} bodies upward`
          : 'CPU worker is faster or tied across the tested batch sizes'
      };
    } catch (error) {
      autoPreferGPU = false;
      autoGPUThreshold = Infinity;
      if (!(error instanceof GPUBufferLimitError)) {
        gpuState = 'unavailable';
        gpuDevice = null; gpuPipeline = null; gpuIntegratePipeline = null; gpuInitPromise = null;
        clearGPUBufferPools();
      }
      return { available: false, count: null, cpuAverageMs: null, gpuAverageMs: null,
        preferGPU: false, autoGPUThreshold: null,
        reason: `CPU/GPU physics benchmark failed; Auto selects CPU worker (${error?.message || 'compute error'})` };
    }
  }

  function setMode(mode) {
    physicsMode = ['auto', 'cpu', 'gpu', 'main'].includes(mode) ? mode : 'auto';
    setStatus(`Physics mode: ${physicsMode === 'auto' ? 'Auto (CPU/GPU)' : physicsMode === 'gpu' ? 'WebGPU with CPU fallback' : physicsMode === 'cpu' ? 'CPU worker' : 'Main-thread CPU'}`);
    return physicsMode;
  }

  function scanCPU(demands, capacities) {
    if (!worker) return Promise.resolve(summarizeOnMain(demands, capacities));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, demands, capacities });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    }).catch((error) => {
      // Worker failure must not leave analysis stalled. Retry this snapshot locally.
      if (worker) disableWorker(error);
      return summarizeOnMain(demands, capacities);
    });
  }

  async function scan(demands, capacities) {
    if (!demands || !capacities || typeof demands.length !== 'number' || demands.length !== capacities.length) {
      throw new TypeError('FrameLab compute scan requires equal-length demand and capacity arrays.');
    }
    if (demands.length >= GPU_THRESHOLD && navigator.gpu && gpuState !== 'unavailable') {
      try {
        const result = await scanGPU(demands, capacities);
        backend = result.backend;
        setStatus(`${backend} · ${result.count} members`);
        return result;
      } catch (error) {
        if (!(error instanceof GPUBufferLimitError)) {
          gpuState = 'unavailable';
          gpuDevice = null;
          gpuPipeline = null;
          gpuIntegratePipeline = null;
          gpuInitPromise = null;
          clearGPUBufferPools();
        } else {
          setRuntimeStatus('WebGPU diagnostic batch exceeds adapter limits; CPU diagnostic selected');
        }
      }
    }
    const result = await scanCPU(demands, capacities);
    backend = result.backend;
    setRuntimeStatus(`${backend} · ${result.count} members`);
    return result;
  }

  async function benchmarkGPU() {
    if (!navigator.gpu) return { available: false, averageMs: null, throughput: 0, reason: 'WebGPU unavailable' };
    const count = 4096;
    const demands = new Float32Array(count), capacities = new Float32Array(count);
    for (let i = 0; i < count; i++) { demands[i] = 0.2 + (i % 19) * 0.07; capacities[i] = 0.8 + (i % 23) * 0.09; }
    try {
      // One warm-up includes adapter/pipeline creation and is excluded from timing.
      await scanGPU(demands, capacities);
      const samples = [];
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        await scanGPU(demands, capacities);
        samples.push(Math.max(0.01, performance.now() - start));
      }
      samples.sort((a, b) => a - b);
      const averageMs = (samples[0] + samples[1] + samples[2]) / 3;
      return { available: true, averageMs, throughput: count / (averageMs / 1000), reason: 'WebGPU compute available' };
    } catch (error) {
      if (!(error instanceof GPUBufferLimitError)) {
        gpuState = 'unavailable';
        gpuDevice = null; gpuPipeline = null; gpuIntegratePipeline = null; gpuInitPromise = null;
        clearGPUBufferPools();
      }
      return { available: false, averageMs: null, throughput: 0, reason: `GPU scan unavailable: ${error?.message || 'initialization failed'}` };
    }
  }

  initWorker();
  setStatus(worker ? 'Web Worker ready · GPU on demand' : 'CPU fallback · GPU on demand');
  window.FrameLabCompute = {
    scan,
    benchmarkGPU,
    benchmarkPhysicsBackends,
    getBackend: () => backend,
    getPhysicsBackend: () => physicsBackend,
    getMode: () => physicsMode,
    setMode,
    integrateBodies,
    projectConstraints,
    resolveDebrisPairs,
    bodyStride: BODY_STRIDE,
    getGPUState: () => gpuState,
    getDiagnostics: () => ({
      mode: physicsMode, gpuState,
      autoGPUThreshold: Number.isFinite(autoGPUThreshold) ? autoGPUThreshold : null,
      gpuBodyLimitBytes: Number.isFinite(gpuBodyLimitBytes) ? gpuBodyLimitBytes : null,
      bodyBufferCapacityBytes: gpuBuffers.body.stateCapacity || 0,
      scanBufferCapacityBytes: gpuBuffers.scan.inputCapacity || 0,
      ...computeStats
    }),
    getWorkerURL: () => workerURL.href
  };
})();
