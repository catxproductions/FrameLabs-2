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

  let worker = null;
  let backend = 'Main-thread fallback';
  let gpuState = 'not initialized';
  let gpuDevice = null;
  let gpuPipeline = null;
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
      gpuDevice = device;
      gpuPipeline = pipeline;
      gpuState = 'ready';
      device.lost.then((info) => {
        if (gpuDevice !== device) return;
        gpuDevice = null;
        gpuPipeline = null;
        gpuInitPromise = null;
        gpuState = `lost${info && info.message ? `: ${info.message}` : ''}`;
        backend = worker ? 'Web Worker (CPU)' : 'Main-thread fallback';
        setStatus(`${backend} · GPU unavailable`);
      }).catch(() => {});
    })().catch((error) => {
      gpuState = 'unavailable';
      gpuDevice = null;
      gpuPipeline = null;
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
    getBackend: () => backend,
    getGPUState: () => gpuState,
    getWorkerURL: () => workerURL.href
  };
})();
