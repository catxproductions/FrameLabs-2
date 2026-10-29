# FrameLabs 2 — Native CUDA Tensor Core Mode (experimental)

This folder is a **separate native mode** for CUDA-capable NVIDIA GPUs. It does
not replace or alter the browser/GitHub Pages build, the JavaScript solver, the
CPU worker, or WebGPU fallback. The browser game continues to work without CUDA.

The prototype uses `#include <mma.h>` and CUDA WMMA to run a dense half-precision
matrix multiplication with FP32 accumulation on Tensor Cores. It is a foundation
and hardware/build check for a future native physics backend, not a claim that
Tensor Cores currently accelerate live building collapse, collision detection,
or the existing web game. Those physics workloads are not automatically dense
matrix operations, so connecting this mode requires a carefully chosen physics
algorithm and numerical validation.

## Requirements

- NVIDIA GPU with Tensor Core support (compute capability 7.0 or newer).
- NVIDIA driver and CUDA Toolkit with `nvcc`.
- CMake 3.24 or newer and a supported C++ compiler.
- RTX 4060 Ti uses Ada Lovelace, compute capability 8.9.

## Build

From the repository root, in an environment with the CUDA Toolkit installed:

```sh
cmake -S cuda -B build/cuda -DCMAKE_CUDA_ARCHITECTURES=89
cmake --build build/cuda --config Release
```

Run the matrix benchmark (size must be a multiple of 16, between 16 and 8192):

```sh
./build/cuda/framelabs_cuda_mode 1024
```

On Windows, the executable may be under `build/cuda/Release/`.

For another NVIDIA GPU, change `CMAKE_CUDA_ARCHITECTURES` to a supported target.
This mode needs a native CUDA environment; it cannot be compiled into the normal
GitHub Pages JavaScript/WebAssembly build by adding the header to the existing
`cpp/physics_core.cpp`.

## Next integration step

Use a native host executable or service boundary to pass an explicitly selected,
validated workload to CUDA, and retain the existing CPU/WebGPU backends as
fallbacks. Benchmark end-to-end transfer and dispatch overhead before routing
small workloads to the GPU. Do not move irregular contact/failure logic to
Tensor Cores merely to use the hardware; use CUDA C++ kernels for suitable
parallel physics work and WMMA only where matrix math is actually appropriate.
