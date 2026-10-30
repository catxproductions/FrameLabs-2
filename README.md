# FrameLabs 2 — structural sandbox with adaptive physics and compute helpers

This package is based on the supplied original FrameLab project. It preserves the original building examples, structural solver, layout, materials, failure flow, and canvas renderer while adding a reduced-order contact/environment model and a few optional interaction/rendering systems.

## Run

Serve the folder over HTTP/HTTPS (for example, GitHub Pages or `python -m http.server`), then open `index.html`. Do not launch with `file://` when testing workers or WebGPU. GPU availability depends on browser, OS, driver, device and secure-context support.

## New behavior

- **120 Hz fixed substeps** use a capped accumulator, bounded catch-up work, swept debris/member contact checks, and quality-dependent iterative member constraints. On very slow frames, excess wall-clock time is intentionally discarded to avoid a spiral of death; physics cannot guarantee perfect real-time catch-up on a heavily overloaded device.
- **Material-pair friction and restitution** vary smoothly with relative contact speed and the surface-moisture setting, with different material parameters for steel, concrete, wood, flammable composite and explosive composite.
- **Impact deformation** combines a temporary elastic component (which recovers over time) with a persistent plastic component. This is a simplified member-level deformation model, not a full deformable-mesh or mass-spring soft-body solver.
- **Environmental forces** add area/mass-scaled quadratic drag and density-dependent buoyancy to loose debris, plus a reduced buoyancy/drag response on structural nodes when water is enabled. Parameters use normalized game units and are illustrative, not SI-calibrated.
- **Gravity Tether (`T`)** lets the user click-drag a nearby joint or debris member with a damped, force-capped spring; detached members can swing, rotate, collide and settle when released.
- **Adaptive quality** performs a brief synthetic CPU constraint benchmark and, where available, a supplemental WebGPU demand/capacity-scan benchmark. Entry/Balanced/Enthusiast presets tune constraint iterations, debris and particle caps, render pixel ratio, contact-shadow approximation, and atmospheric/wet highlights. Manual presets remain selected instead of being overwritten by the automatic result.
- **Wind loading** is a structural input as well as a motion/visual effect. Pressure-based demand scales with wind speed squared and is increased by gusts, height, windward exposure and member type. It feeds the existing member utilization, beam bending, sustained-overload weakening and failure path; weak framing can fail under severe sustained wind while stronger members are less affected. Wind values are illustrative game units, not real-world engineering calculations.
- **Moisture and water sliders** influence contact response and provide lightweight Canvas2D material/water visual cues.
- **Collapse dust and fire smoke** use world-space particles: member failures produce soft, expanding dust bursts, fast ground impacts kick up larger plumes, and burning structural members/debris continuously emit gray smoke that rises, drifts and fades. Particle motion runs on the render clock (including while physics is paused), and each quality preset limits the active particle budget to avoid unbounded growth. These are layered Canvas2D sprites, not volumetric simulation.
- **Immersive fullscreen (`F`)** opens a simulation-first fullscreen view when the browser supports native fullscreen; press `Esc` to exit native fullscreen. **Icons: On/Off (`O`)** toggles drawing annotations such as node labels and load arrows. The simulation preserves its aspect ratio rather than stretching to fit unusual screen shapes.

## Material library and beginner guide

Material definitions are centralized in `js/materials.js`, separate from the formulas and environment response in `js/physics-model.js`. Each material has explicit Boolean `isExplosive` and `isFlamable` settings (the library also accepts the usual spelling `isFlammable`). Set either or both to `true` to enable the existing virtual fire and/or chain-reaction behavior for that material.

To add a material, use the readable `addMaterial({...})` helper in `js/materials.js`. You can base it on an existing material, then override its color, component mass/strength, friction, heat response, impact resistance, or behavior flags. The Material dropdown updates when a new material is registered. Building JSON exports include custom material definitions and their impact-resistance settings, so compatible custom materials can be restored when importing a design.

Start with the [beginner material guide](js/MATERIALS_GUIDE.md). The guide explains the required ID, inherited defaults, behavior flags, and a copy-edit example. Material values are simplified game settings, not real-world engineering data.

## CPU worker and WebGPU physics integration

- The **Physics compute** selector offers Auto, CPU worker, WebGPU (with CPU fallback), main-thread CPU compatibility, and an opt-in native RTX CUDA mode or the separate native Vulkan RTX mode.
- `js/compute-worker.js` performs live batched semi-implicit integration of structural-node and debris positions, velocities, and angular state off the main thread. It also runs ordered Gauss-Seidel member-length constraint iterations and the follow-up velocity projection, and retains the demand/capacity diagnostic scan.
- `js/compute-backends.js` routes motion integration to the persistent CPU worker or WebGPU. Auto mode benchmarks 256, 1,024, and 4,096-body batches and enables GPU integration only from a measured crossover where WebGPU is at least 15% faster at that size and all larger tested sizes. It does not assume that an available GPU is always faster.
- WebGPU state, uniform, and readback buffers are reused across fixed 120 Hz substeps instead of being created and destroyed for each batch. Readback is still required because the authoritative structural solver consumes the updated state on the CPU, so tiny batches can still favor the worker.
- Motion packing reuses typed-array scratch buffers. The CPU worker returns the same transferred body buffer in place, including a length for the active portion of a larger scratch buffer; this avoids an extra worker-side output allocation. The main-thread path rebuilds state and retries CPU integration if a transferred worker job fails.
- Force assembly, material/environment calculations, structural analysis and load-path propagation, member-failure rules, and impact damage/fragmentation decisions remain in JavaScript on the CPU. The ordered member-constraint pass runs in the CPU worker, body integration can run in the worker, WebGPU, or the optional native RTX CUDA bridge, and larger debris-pair batches can use the C++/WebAssembly contact kernel in that worker. GPU-backed body integration does not replace structural or collision/failure decisions.
- GPU initialization/dispatch errors degrade to CPU worker and then a main-thread CPU implementation if a worker is unavailable. Over-limit GPU batches fall back to CPU for those batch sizes without permanently disabling smaller GPU batches. Hot-path status updates are coalesced to four per second, and catch-up physics work yields to the next animation frame so the browser gets time to paint and process input. Worker URLs are resolved relative to the backend script for GitHub Pages subpaths.

## Experimental RTX Mode (native CUDA)

RTX Mode connects the browser game to a separate native helper running on the same PC. It requires a supported NVIDIA RTX GPU and a CUDA Toolkit/compiler. Build it from the repository root:

```sh
cmake -S cuda -B build/cuda -DCMAKE_CUDA_ARCHITECTURES=89
cmake --build build/cuda --config Release
./build/cuda/framelabs_rtx_mode --serve
```

On Windows, the executable may be at `build/cuda/Release/framelabs_rtx_mode.exe`; run it with `--serve` and keep the terminal open. Then open the FrameLabs 2 GitHub Pages site and choose **Physics compute → RTX Mode** (CUDA) or **Vulkan RTX Mode** (Vulkan). The site checks the local helper only after selection and may request browser loopback/local-network permission. Approve access only if you launched the FrameLabs helper yourself.

The helper listens exclusively on `127.0.0.1:47652`, permits the FrameLabs GitHub Pages origin and localhost development origins, and does not listen on a LAN address. RTX Mode sends moving-body state to a CUDA kernel for position/velocity/rotation integration. If the helper disappears, the selector returns to the previous browser mode.

The live motion kernel uses ordinary CUDA parallel arithmetic; the independent Tensor Core WMMA benchmark uses `#include <mma.h>`. The live per-body operation is not a dense matrix multiplication, so the WMMA benchmark is not falsely presented as accelerating real physics. Structural analysis, wind/fire damage, collisions, and member-failure decisions remain on CPU. Network transfer and memory-copy overhead may outweigh CUDA gains on smaller batches. This mode is experimental until built and profiled on an actual RTX computer.

## Experimental Vulkan RTX Mode (native Vulkan, no CUDA)

Vulkan RTX Mode is a separate opt-in backend and does not use the CUDA Toolkit or the CUDA helper. It connects to a native Vulkan helper on the same PC at 127.0.0.1:47653. The browser mode is wired to a distinct health/integration protocol and falls back to the previously selected browser backend if the helper disconnects.

Important: the live browser integration path remains standard Vulkan compute. A separate, genuine cooperative-matrix validation executable is included in the Vulkan build. It queries supported formats, dispatches a real Khronos cooperative-matrix FP16 16x16 × FP16 16x16 multiply with FP32 accumulation, and validates all 256 output values. This proves actual cooperative-matrix dispatch when the probe reports PASS, but it is not yet connected to live structural physics. Do not claim live gameplay is Tensor Core accelerated until a suitable structural-solver workload is integrated and measured.

The native helper requires the Vulkan SDK/runtime (including `glslc`) and a compatible NVIDIA driver. It is intentionally separate from `cuda/` so Vulkan builds do not require nvcc or CUDA libraries. Build it from the repository root with `cmake -S vulkan -B build/vulkan` followed by `cmake --build build/vulkan --config Release`. On Windows, run `build/vulkan/Release/framelabs_vulkan_rtx_mode.exe` for the game helper and `build/vulkan/Release/framelabs_coopmat_probe.exe` to validate the cooperative-matrix dispatch; see [the Vulkan helper guide](vulkan/README.md) for details.

## Pre-calculation and replay

- **Pre-calculate** advances the existing authoritative `stepPhysics(DT)` solver ahead of wall-clock time, yields between small batches so the page can update progress, and supports cancellation. The starting simulation state is restored when baking finishes or is cancelled.
- The bake stores full-state graph snapshots at 0.25-second simulation intervals. Replay offers timeline seeking, play/pause/stop, and 0.25×, 0.5×, 1×, and 2× playback speeds. Seeking restores a recorded checkpoint; it does not integrate intermediate frames between checkpoints.
- Snapshot cloning preserves object prototypes, cycles, shared references, and typed arrays so structural links continue to reference the cloned members and nodes. An estimated 64 MiB checkpoint budget bounds memory use; very large designs may stop baking early.
- Replay checks the design layout, environment inputs, quality preset, and compute backend before playback. If those inputs no longer match, bake again. The checkpoints are an in-memory session feature and are not exported in the BuildingMap JSON file.
- Pre-calculation uses the selected compute backend through the same solver path; it does not create a second physics engine. Replay is a playback of recorded checkpoints, not a validated engineering analysis or a guarantee of bit-for-bit deterministic recomputation.

## Rendering and modeling limits

FrameLab is a 2D Canvas simulation. Contact shadows, wet highlights, haze and water appearance are Canvas2D approximations; this is not a true 3D screen-space contact-shadow or volumetric-lighting pipeline. The structural engine retains force assembly, load propagation, connectivity, failure and collision response on the CPU; repeated member constraint projections run in the CPU worker, while node/debris integration can run through the CPU worker or WebGPU backend. The new material/environment model and visual deformation improve feedback but are not a validated engineering or finite-element solver. Do not use the simulation for real structural design or safety decisions.

## Checks

Run:

```sh
npm run check
```

The tests check example JSON integrity, asset and script load order, worker URLs, material flags and custom-material registration/inheritance, material-definition JSON serialization, CPU-worker diagnostic and live body-integration math, CPU member-constraint projection, selectable CPU fallback, backend wiring into both node and debris motion, GPU-unavailable handling, fixed-step/UI wiring, nonlinear contact response, submersion/buoyancy, quality selection, moisture shading, dust/smoke particle lifetime and caps, and particle-render/event wiring. These automated tests do not replace an interactive browser/hardware test of the complete game.


## Experimental C++/WebAssembly physics kernel

FrameLabs 2 has an optional C++ module compiled to WebAssembly for body integration, structural-link constraint projection, and larger debris-pair collision/impact batches. These kernels run inside the existing CPU Web Worker. JavaScript remains responsible for structural analysis, member-failure rules, impact damage and fragmentation decisions, fire spread, effects, and UI. The debris kernel handles oriented-box overlap checks, penetration correction, contact impulses, friction/rotational response, and impact-energy estimates for candidate pairs supplied by JavaScript. This is an incremental compute backend, not a full physics-engine replacement.

The constraint kernel mirrors the ordered Gauss-Seidel calculations already used by the JavaScript worker so both paths can be compared before changing solver behavior. JavaScript worker implementations remain available if WebAssembly is missing, fails to load, or cannot allocate enough memory. WebAssembly threads are not required.

Rebuild the browser asset with Clang and LLD installed:

```sh
npm run build:wasm
npm run check
```

GitHub Actions builds and commits the compiled `js/physics-core.wasm` asset to the branch after the regression suite passes. Browser performance still needs to be benchmarked before increasing solver iterations or making C++ the only backend; WebAssembly does not guarantee a speedup for every structure size.


### Before increasing solver quality

The built-in crossover benchmark uses the same worker/GPU round-trip path that live integration uses, with warm-up and median samples across three batch sizes. It is a useful per-device routing heuristic, not a substitute for profiling real structures. Verify frame time and collision behavior on small, medium, and large saves before making claims about gains from a release build.


### C++ debris-contact computation

For batches containing 16 or more broadphase candidate pairs, the optional C++/WebAssembly worker handles oriented-box contact checks, penetration correction, normal and friction impulses, angular response, and impact-energy estimates. JavaScript still builds the spatial hash, applies impact damage and fragmentation decisions, and retains the original collision solver as a fallback when Wasm is unavailable or the batch is small. Browser profiling is still needed before claiming an end-user speedup.
