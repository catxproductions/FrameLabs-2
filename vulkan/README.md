Vulkan RTX Mode native helper (no CUDA)

Requirements: NVIDIA RTX GPU, current Vulkan-capable NVIDIA driver, Vulkan SDK with glslc, CMake 3.24+, and a C++17 compiler.

Build from the repository root:

    cmake -S vulkan -B build/vulkan
    cmake --build build/vulkan --config Release

On Windows run build/vulkan/Release/framelabs_vulkan_rtx_mode.exe. Keep it running, open FrameLabs 2, and choose Physics compute > Vulkan RTX Mode. Approve loopback access only after starting this helper yourself.

The helper binds only to 127.0.0.1:47653 and accepts the FrameLabs GitHub Pages origin and localhost development origins. It exposes GET /health and POST /integrate. Structural analysis, collision resolution, environmental damage, and failure decisions remain in JavaScript on the CPU.

Tensor Core status: the helper reports whether the Vulkan driver exposes a cooperative-matrix extension. This is only a capability signal. The current body integration shader uses ordinary floating-point compute and does NOT dispatch Tensor Core operations. A separate cooperative-matrix kernel and suitable matrix-heavy physics workload are required before claiming Tensor Core acceleration.
