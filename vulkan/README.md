Vulkan RTX Mode native helper (no CUDA)

Requirements: NVIDIA RTX GPU, current Vulkan-capable NVIDIA driver, Vulkan SDK with glslc, CMake 3.24+, and a C++17 compiler.

Build from the repository root:

    cmake -S vulkan -B build/vulkan
    cmake --build build/vulkan --config Release

On Windows run build/vulkan/Release/framelabs_vulkan_rtx_mode.exe. Keep it running, open FrameLabs 2, and choose Physics compute > Vulkan RTX Mode. Approve loopback access only after starting this helper yourself.

The helper binds only to 127.0.0.1:47653 and accepts the FrameLabs GitHub Pages origin and localhost development origins. It exposes GET /health and POST /integrate. Structural analysis, collision resolution, environmental damage, and failure decisions remain in JavaScript on the CPU.

## Genuine cooperative-matrix validation

The build also creates a separate executable:

    build/vulkan/Release/framelabs_coopmat_probe.exe

Run it on an NVIDIA RTX machine with a Vulkan driver that supports VK_KHR_cooperative_matrix and the exact matrix shape used by the test. The probe queries the device's cooperative-matrix properties and enabled features, then dispatches a real coopMatMulAdd operation from a Vulkan compute shader:

- A: 16x16 FP16
- B: 16x16 FP16
- accumulator/output: 16x16 FP32
- scope: subgroup

The test initializes A to 1.0 and B to 2.0, so every output element must equal 32.0. It prints PASS only after reading back and validating all 256 results. If the driver does not expose the required extension, feature, or shape, it exits with an explanatory error instead of pretending the operation ran.

This probe is a genuine cooperative-matrix dispatch, but it is currently a hardware validation/benchmark foundation, not yet part of live FrameLabs structural physics. The existing /integrate body-motion shader remains ordinary Vulkan compute. Do not describe live gameplay as Tensor Core accelerated until a useful structural-solver workload is integrated and measured.
