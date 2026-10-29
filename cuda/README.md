# FrameLabs 2 — RTX Mode (experimental)

RTX Mode is an **optional native CUDA helper** for a supported NVIDIA RTX
GPU. The regular GitHub Pages build stays browser-based and does not need the
helper. When the helper is running and the user explicitly selects RTX Mode,
the page sends packed moving-body state to a loopback-only service at
`127.0.0.1:47652`. A CUDA kernel integrates each body's position, velocity,
angle, and angular velocity, then returns the updated state to the browser.

This is a real live physics backend, but its scope is deliberately limited:
structural analysis, load-path propagation, member failure, wind/fire damage,
contact/collision decisions, and fragmentation still run in the existing
JavaScript/CPU solver. The live per-body integration kernel uses ordinary
CUDA parallel arithmetic. It does not use Tensor Cores because independent
per-body integration is not a dense matrix-multiplication workload, and
forcing WMMA into it would not reliably improve performance.

The separate prototype benchmark uses CUDA WMMA via `#include <mma.h>` to
run dense half-precision matrix multiplication with FP32 accumulation on
Tensor Cores. It warms up the kernel, measures repeated launches, reports
approximate matrix throughput (not end-to-end simulation performance), checks
for finite output, and compares sampled output cells against a CPU reference.
This benchmark demonstrates Tensor Core availability and provides a GPU test;
it is not counted as live-physics acceleration.

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

Run the matrix benchmark (size must be a multiple of 16, between 16 and 8192;
optional measured launch count is 1–1000, default 10):

```sh
./build/cuda/framelabs_rtx_mode 1024 10
./build/cuda/framelabs_rtx_mode --help
```

On Windows, the executable may be under `build/cuda/Release/`.

## Run the live RTX helper

Start the local bridge in a separate terminal and leave it running while playing:

```sh
./build/cuda/framelabs_rtx_mode --serve
```

On Windows, run `build\\cuda\\Release\\framelabs_rtx_mode.exe --serve`.
The helper verifies that the selected CUDA device name identifies an RTX GPU,
then binds only to `127.0.0.1:47652` (not to your LAN). Keep the terminal open
while using RTX Mode. In FrameLabs 2, choose **Physics compute → RTX Mode** and
confirm the hardware warning. Some browsers ask for loopback/local-network
permission for the HTTPS game to access the local helper. Grant it only when
you started the FrameLabs helper yourself.

The helper allows the FrameLabs 2 GitHub Pages origin and localhost development
origins, rejects other web origins, and exposes only `GET /health` and
`POST /integrate`. If the connection fails or the helper exits, FrameLabs
returns to the previously selected browser backend. If the helper is not
running, RTX Mode will not activate. This local bridge is experimental: network
round-trip and memory-copy costs may outweigh GPU gains for small body batches,
so measure actual frame times before concluding it is faster.

For another NVIDIA GPU, change `CMAKE_CUDA_ARCHITECTURES` to a supported target.
The WMMA benchmark requires Tensor Core support; live RTX Mode requires a
supported RTX GPU and a native CUDA environment. Neither can be compiled into
the normal GitHub Pages JavaScript/WebAssembly build by adding `<mma.h>` to
`cpp/physics_core.cpp`.

## Remaining scope

Only body-motion integration currently runs through the native CUDA bridge.
The main structural and collision solver remains in JavaScript/CPU code. Do not
move irregular contact/failure logic to Tensor Cores merely to use the hardware;
use CUDA kernels for suitable parallel work and WMMA only where matrix math is
actually appropriate. End-to-end browser/hardware profiling and an actual RTX
GPU build/test are still required before treating this mode as release-validated.
