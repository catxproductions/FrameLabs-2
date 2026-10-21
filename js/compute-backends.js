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
  const GPU_BODY_THRESHOLD = 256;
  let autoPreferGPU = false; // Conservative until a real body-integration benchmark proves otherwise.
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

  const statusEl = () => document.getElementById('computeMetric');
  function setStatus(text) {
    const el = statusEl();
    if (el) el.textContent = text;
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
      throw error;
    });
    return gpuInitPromise;
  }

  async function scanGPU(demands, capacities) {
    await initGPU();
    const device = gpuDevice;
    const pipeline = gpuPipeline;
    if (!device || !pipeline) throw new Error('GPU not ready');
    const count = demands.length;
    if (count === 0) return { backend: 'WebGPU compute', count: 0, maxUtil: 0, meanUtil: 0, overloaded: 0 };

    const packed = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      packed[i * 2] = finiteNonNegative(demands[i]);
      packed[i * 2 + 1] = Math.max(0.01, finiteNonNegative(capacities[i]));
    }

    let input, output, readback, uniform, mapped = false;
    try {
      input = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const outputSize = count * Float32Array.BYTES_PER_ELEMENT;
      output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      readback = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      uniform = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(input, 0, packed);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([count]));
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: uniform } }
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
      await readback.mapAsync(GPUMapMode.READ);
      mapped = true;
      const ratios = new Float32Array(readback.getMappedRange().slice(0));
      return summarizeRatios(ratios, 'WebGPU compute', count);
    } finally {
      if (mapped && readback) {
        try { readback.unmap(); } catch (_) {}
      }
      for (const buffer of [input, output, readback, uniform]) {
        try { buffer?.destroy(); } catch (_) {}
      }
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
    if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) {
      throw new Error("Physics batch exceeds this GPU adapter's storage-buffer limit");
    }
    let state, uniform, readback, mapped = false;
    try {
      state = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(state, 0, packed);
      const params = new ArrayBuffer(16), view = new DataView(params);
      view.setUint32(0, count, true); view.setFloat32(4, Math.max(0, Math.min(0.05, Number(dt) || 0)), true);
      device.queue.writeBuffer(uniform, 0, params);
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: state } }, { binding: 1, resource: { buffer: uniform } }]
      });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
      encoder.copyBufferToBuffer(state, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ); mapped = true;
      return new Float32Array(readback.getMappedRange().slice(0));
    } finally {
      if (mapped && readback) { try { readback.unmap(); } catch (_) {} }
      for (const buffer of [state, uniform, readback]) { try { buffer?.destroy(); } catch (_) {} }
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
    if (!worker) return Promise.resolve(projectConstraintsCPU(nodes, edges, iterations));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (message) => {
        if (!message || !(message.data instanceof ArrayBuffer)) { reject(new Error('CPU worker returned an invalid constraint result')); return; }
        resolve(new Float64Array(message.data));
      }, reject });
      try {
        const nodeCopy = new Float64Array(nodes), edgeCopy = new Float64Array(edges);
        worker.postMessage({ id, type: 'projectConstraints', nodes: nodeCopy.buffer, edges: edgeCopy.buffer, iterations }, [nodeCopy.buffer, edgeCopy.buffer]);
      } catch (error) { pending.delete(id); reject(error); }
    }).catch((error) => {
      if (worker) disableWorker(error);
      return projectConstraintsCPU(new Float64Array(nodes), new Float64Array(edges), iterations);
    });
  }

  async function projectConstraints(nodes, edges, iterations) {
    if (!(nodes instanceof Float64Array) || nodes.length % 5 !== 0 || !(edges instanceof Float64Array) || edges.length % 4 !== 0) {
      throw new TypeError('Constraint projection requires Float64 node state (5 values per node) and edge state (4 values per link).');
    }
    for (let i = 0; i < nodes.length; i++) if (!Number.isFinite(nodes[i])) nodes[i] = 0;
    for (let i = 0; i < edges.length; i++) if (!Number.isFinite(edges[i])) edges[i] = 0;
    const result = physicsMode === 'main'
      ? projectConstraintsCPU(new Float64Array(nodes), new Float64Array(edges), iterations)
      : await projectConstraintsWorker(nodes, edges, iterations);
    if (physicsMode === 'main') physicsBackend = 'Main-thread CPU';
    else if (!worker) physicsBackend = 'Main-thread CPU fallback';
    else if (physicsBackend.includes('WebGPU')) physicsBackend = 'WebGPU integration + CPU worker constraints';
    else physicsBackend = 'CPU worker integration + CPU constraints';
    backend = physicsBackend;
    setStatus(physicsBackend);
    return result;
  }

  function integrateWorker(packed, dt) {
    if (!worker) return Promise.resolve(integrateCPU(packed, dt));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (data) => {
        if (!data || !(data.data instanceof ArrayBuffer || ArrayBuffer.isView(data.data))) {
          reject(new Error('CPU worker returned an invalid physics result')); return;
        }
        resolve(data.data instanceof ArrayBuffer ? new Float32Array(data.data) : new Float32Array(data.data));
      }, reject });
      try {
        const payload = new Float32Array(packed);
        worker.postMessage({ id, type: 'integrateBodies', dt, data: payload.buffer }, [payload.buffer]);
      } catch (error) { pending.delete(id); reject(error); }
    }).catch((error) => {
      if (worker) disableWorker(error);
      return integrateCPU(new Float32Array(packed), dt);
    });
  }

  async function integrateBodies(packed, dt) {
    if (!(packed instanceof Float32Array) || packed.length % BODY_STRIDE !== 0) {
      throw new TypeError(`Physics integration requires a Float32Array with ${BODY_STRIDE} values per body.`);
    }
    if (!Number.isFinite(Number(dt)) || dt < 0 || dt > 0.05) throw new RangeError('Physics dt must be between 0 and 0.05 seconds.');
    if (packed.length === 0) return { data: packed, backend: 'No dynamic bodies' };
    for (let i = 0; i < packed.length; i++) if (!Number.isFinite(packed[i])) packed[i] = 0;
    const useGPU = physicsMode === 'gpu' || (physicsMode === 'auto' && autoPreferGPU && packed.length / BODY_STRIDE >= GPU_BODY_THRESHOLD && navigator.gpu && gpuState !== 'unavailable');
    if (useGPU && navigator.gpu && gpuState !== 'unavailable') {
      try {
        const result = await integrateGPU(packed, dt);
        physicsBackend = 'WebGPU physics';
        backend = physicsBackend;
        setStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
        return { data: result, backend: physicsBackend };
      } catch (error) {
        gpuState = 'unavailable'; gpuDevice = null; gpuPipeline = null; gpuIntegratePipeline = null; gpuInitPromise = null;
        if (physicsMode === 'gpu') setStatus(`WebGPU failed; using CPU · ${error?.message || 'GPU error'}`);
      }
    }
    if (physicsMode === 'main') {
      const result = integrateCPU(new Float32Array(packed), dt);
      physicsBackend = 'Main-thread CPU'; backend = physicsBackend;
      setStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
      return { data: result, backend: physicsBackend };
    }
    const result = await integrateWorker(packed, dt);
    physicsBackend = worker ? 'CPU worker physics' : 'Main-thread CPU fallback';
    backend = physicsBackend;
    setStatus(`${physicsBackend} · ${result.length / BODY_STRIDE} bodies`);
    return { data: result, backend: physicsBackend };
  }

  async function benchmarkPhysicsBackends() {
    if (!navigator.gpu) {
      autoPreferGPU = false;
      return { available: false, cpuAverageMs: null, gpuAverageMs: null, preferGPU: false, reason: 'WebGPU unavailable; Auto selects CPU worker' };
    }
    const count = 1024, packed = new Float32Array(count * BODY_STRIDE);
    for (let i = 0; i < count; i++) {
      const b = i * BODY_STRIDE;
      packed[b] = (i % 37) * 0.03; packed[b + 1] = (i % 29) * 0.02;
      packed[b + 2] = ((i % 7) - 3) * 0.01; packed[b + 3] = ((i % 11) - 5) * 0.01;
      packed[b + 4] = ((i % 13) - 6) * 0.2; packed[b + 5] = -9.81;
      packed[b + 6] = (i % 17) * 0.01; packed[b + 7] = ((i % 5) - 2) * 0.02;
      packed[b + 8] = 0.1; packed[b + 9] = 0.998;
      packed[b + 10] = 5; packed[b + 11] = 15; packed[b + 12] = 3.4;
    }
    try {
      // Warm both paths before timing; timings include worker/GPU round trips just like a live step.
      await integrateWorker(new Float32Array(packed), 1 / 120);
      await integrateGPU(new Float32Array(packed), 1 / 120);
      const cpuSamples = [], gpuSamples = [];
      for (let run = 0; run < 3; run++) {
        let start = performance.now(); await integrateWorker(new Float32Array(packed), 1 / 120); cpuSamples.push(Math.max(0.01, performance.now() - start));
        start = performance.now(); await integrateGPU(new Float32Array(packed), 1 / 120); gpuSamples.push(Math.max(0.01, performance.now() - start));
      }
      cpuSamples.sort((a, b) => a - b); gpuSamples.sort((a, b) => a - b);
      const cpuAverageMs = cpuSamples[1], gpuAverageMs = gpuSamples[1];
      // Require a 15% win to avoid choosing GPU based on noisy, effectively tied samples.
      autoPreferGPU = gpuAverageMs < cpuAverageMs * 0.85;
      return { available: true, count, cpuAverageMs, gpuAverageMs, preferGPU: autoPreferGPU,
        reason: autoPreferGPU ? 'GPU body integration benchmarked faster' : 'CPU worker matched or beat GPU body integration' };
    } catch (error) {
      autoPreferGPU = false;
      return { available: false, count, cpuAverageMs: null, gpuAverageMs: null, preferGPU: false,
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
      } catch (_) {
        gpuState = 'unavailable';
        gpuDevice = null;
        gpuPipeline = null;
        gpuIntegratePipeline = null;
        gpuInitPromise = null;
      }
    }
    const result = await scanCPU(demands, capacities);
    backend = result.backend;
    setStatus(`${backend} · ${result.count} members`);
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
      gpuState = 'unavailable';
      gpuDevice = null; gpuPipeline = null; gpuInitPromise = null;
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
    bodyStride: BODY_STRIDE,
    getGPUState: () => gpuState,
    getWorkerURL: () => workerURL.href
  };
})();
