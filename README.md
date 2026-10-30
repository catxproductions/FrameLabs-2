# FrameLabs 2 — structural sandbox with adaptive physics and compute helpers

This package is based on the supplied original FrameLab project. It preserves the original building examples, structural solver, layout, materials, failure flow, and canvas renderer while adding a reduced-order contact/environment model and a few optional interaction/rendering systems.

## Run

Serve the folder over HTTP/HTTPS (for example, GitHub Pages or `python -m http.server`), then open `index.html`. Do not launch with `file://` when testing workers or WebGPU. GPU availability depends on browser, OS, driver, device and secure-context support.

## Experimental Vulkan RTX Mode (native Vulkan, no CUDA)

Vulkan RTX Mode is a separate opt-in backend and does not use the CUDA Toolkit or the CUDA helper. It connects to a native Vulkan helper on the same PC at 127.0.0.1:47653. The browser mode uses a distinct health/integration protocol and falls back to the previously selected browser backend if the helper disconnects.

The live browser integration path is still standard Vulkan compute. A separate, genuine cooperative-matrix validation executable is now included in the Vulkan build. It queries the driver's supported cooperative-matrix formats, creates a Vulkan compute pipeline using the Khronos GLSL cooperative-matrix extension, dispatches an FP16 16x16 by FP16 16x16 multiply with FP32 accumulation, and validates all 256 output values. See [the Vulkan helper guide](vulkan/README.md) for build and run instructions.

Important: this is a real cooperative-matrix dispatch test, but it is not yet connected to live structural physics. The live per-body integration shader remains ordinary floating-point Vulkan compute. Do not claim live gameplay is Tensor Core accelerated until a suitable matrix-heavy structural-solver workload is integrated and measured on supported hardware.

The native helper and cooperative-matrix probe require the Vulkan SDK/runtime (including `glslc`) and a compatible NVIDIA driver. They are intentionally separate from `cuda/` so Vulkan builds do not require nvcc or CUDA libraries. Build from the repository root with `cmake -S vulkan -B build/vulkan` followed by `cmake --build build/vulkan --config Release`. On Windows, run `build/vulkan/Release/framelabs_vulkan_rtx_mode.exe` to start the game helper and `build/vulkan/Release/framelabs_coopmat_probe.exe` to run the cooperative-matrix validation.

## CPU worker and WebGPU physics integration

- The **Physics compute** selector offers Auto, CPU worker, WebGPU (with CPU fallback), main-thread CPU compatibility, an opt-in native RTX CUDA mode, and a separate native Vulkan RTX mode.
- `js/compute-worker.js` performs live batched semi-implicit integration of structural-node and debris positions, velocities, and angular state off the main thread. It also runs ordered Gauss-Seidel member-length constraint iterations and the follow-up velocity projection, and retains the demand/capacity diagnostic scan.
- `js/compute-backends.js` routes motion integration to the persistent CPU worker or WebGPU. Auto mode benchmarks 256, 1,024, and 4,096-body batches and enables GPU integration only from a measured crossover where WebGPU is at least 15% faster at that size and all larger tested sizes. It does not assume that an available GPU is always faster.
- WebGPU state, uniform, and readback buffers are reused across fixed 120 Hz substeps instead of being created and destroyed for each batch. Readback is still required because the authoritative structural solver consumes the updated state on the CPU, so tiny batches can still favor the worker.
- Force assembly, material/environment calculations, structural analysis and load-path propagation, member-failure rules, and impact damage/fragmentation decisions remain in JavaScript on the CPU. GPU-backed body integration does not replace structural or collision/failure decisions.

