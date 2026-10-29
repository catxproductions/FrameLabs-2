#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <mma.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace wmma = nvcuda::wmma;

#define CUDA_CHECK(call) do { \
  const cudaError_t error = (call); \
  if (error != cudaSuccess) { \
    std::cerr << "CUDA error: " << cudaGetErrorString(error) \
              << " at " << __FILE__ << ":" << __LINE__ << "\n"; \
    return 1; \
  } \
} while (0)

// Separate native RTX Mode prototype. It does not replace the browser solver.
// WMMA computes a dense matrix product using Tensor Cores; future physics
// integration should only route suitable dense workloads through this API.
__global__ void tensorCoreMatmul(const half* a, const half* b, float* c,
                                 int matrixSize) {
  // Every lane in this warp must participate in each WMMA operation.
  // One 32-thread block cooperatively computes one 16x16 output tile.
  const int tileRow = blockIdx.y * wmma::M;
  const int tileCol = blockIdx.x * wmma::N;
  if (tileRow >= matrixSize || tileCol >= matrixSize) return;

  wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> aFrag;
  wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> bFrag;
  wmma::fragment<wmma::accumulator, 16, 16, 16, float> accFrag;
  wmma::fill_fragment(accFrag, 0.0f);

  for (int k = 0; k < matrixSize; k += 16) {
    wmma::load_matrix_sync(aFrag, a + tileRow * matrixSize + k, matrixSize);
    wmma::load_matrix_sync(bFrag, b + k * matrixSize + tileCol, matrixSize);
    wmma::mma_sync(accFrag, aFrag, bFrag, accFrag);
  }

  wmma::store_matrix_sync(c + tileRow * matrixSize + tileCol, accFrag,
                          matrixSize, wmma::mem_row_major);
}

int main(int argc, char** argv) {
  int n = 1024;
  if (argc > 1) {
    char* end = nullptr;
    const long parsed = std::strtol(argv[1], &end, 10);
    if (!end || *end != '\0' || parsed < 16 || parsed > 8192 ||
        parsed % 16 != 0) {
      std::cerr << "Usage: framelabs_rtx_mode [matrix-size-multiple-of-16]\n";
      return 2;
    }
    n = static_cast<int>(parsed);
  }

  int deviceCount = 0;
  CUDA_CHECK(cudaGetDeviceCount(&deviceCount));
  if (deviceCount == 0) {
    std::cerr << "No CUDA-capable NVIDIA GPU was found.\n";
    return 2;
  }

  cudaDeviceProp device{};
  CUDA_CHECK(cudaGetDeviceProperties(&device, 0));
  if (device.major < 7) {
    std::cerr << "This WMMA Tensor Core prototype requires compute capability 7.0+.\n";
    return 2;
  }
  CUDA_CHECK(cudaSetDevice(0));

  const std::size_t elements = static_cast<std::size_t>(n) * n;
  std::vector<half> hostA(elements), hostB(elements);
  std::vector<float> hostC(elements, 0.0f);
  std::mt19937 rng(12345);
  std::uniform_real_distribution<float> dist(-0.5f, 0.5f);
  for (std::size_t i = 0; i < elements; ++i) {
    hostA[i] = __float2half(dist(rng));
    hostB[i] = __float2half(dist(rng));
  }

  half *deviceA = nullptr, *deviceB = nullptr;
  float* deviceC = nullptr;
  CUDA_CHECK(cudaMalloc(reinterpret_cast<void**>(&deviceA), elements * sizeof(half)));
  CUDA_CHECK(cudaMalloc(reinterpret_cast<void**>(&deviceB), elements * sizeof(half)));
  CUDA_CHECK(cudaMalloc(reinterpret_cast<void**>(&deviceC), elements * sizeof(float)));
  CUDA_CHECK(cudaMemcpy(deviceA, hostA.data(), elements * sizeof(half), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(deviceB, hostB.data(), elements * sizeof(half), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(deviceC, 0, elements * sizeof(float)));

  // One warp per block; each block writes one 16x16 tile.
  const dim3 block(32, 1, 1);
  const dim3 grid(n / 16, n / 16, 1);
  cudaEvent_t start{}, stop{};
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  tensorCoreMatmul<<<grid, block>>>(deviceA, deviceB, deviceC, n);
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float elapsedMs = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&elapsedMs, start, stop));
  CUDA_CHECK(cudaMemcpy(hostC.data(), deviceC, elements * sizeof(float), cudaMemcpyDeviceToHost));

  // Lightweight sanity check: C must contain finite values.
  const bool finite = std::all_of(hostC.begin(), hostC.end(),
                                  [](float v) { return std::isfinite(v); });
  std::cout << "FrameLabs 2 — RTX Mode (experimental prototype)\n"
            << "GPU: " << device.name << " (compute " << device.major << "."
            << device.minor << ")\n"
            << "Matrix: " << n << " x " << n << "\n"
            << "WMMA kernel time: " << elapsedMs << " ms\n"
            << "Result sanity check: " << (finite ? "PASS" : "FAIL") << "\n"
            << "Note: this benchmarks Tensor Core matrix math; it is not yet "
               "connected to live FrameLabs structural physics.\n";

  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  CUDA_CHECK(cudaFree(deviceA));
  CUDA_CHECK(cudaFree(deviceB));
  CUDA_CHECK(cudaFree(deviceC));
  return finite ? 0 : 3;
}
