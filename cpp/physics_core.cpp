#include <stdint.h>
#include <stddef.h>

extern "C" {
extern unsigned char __heap_base;
static uint32_t heap_top = 0;

static inline double clampd(double value, double lo, double hi) {
  return value < lo ? lo : (value > hi ? hi : value);
}

// Small resettable allocator. Typed-array copies are made into/out of Wasm memory.
__attribute__((visibility("default"))) uint32_t alloc(uint32_t bytes) {
  if (bytes == 0 || bytes > 0x3fffffffU) return 0;
  if (heap_top == 0) heap_top = (uint32_t)(uintptr_t)&__heap_base;
  const uint32_t start = (heap_top + 7U) & ~7U;
  const uint64_t end64 = (uint64_t)start + (uint64_t)bytes;
  if (end64 > 0xffffffffULL) return 0;
  const uint32_t end = (uint32_t)end64;
  const uint64_t available = (uint64_t)__builtin_wasm_memory_size(0) * 65536ULL;
  if ((uint64_t)end > available) {
    const uint32_t pages = (uint32_t)(((uint64_t)end - available + 65535ULL) / 65536ULL);
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  }
  heap_top = end;
  return start;
}

__attribute__((visibility("default"))) void reset_alloc() {
  heap_top = (uint32_t)(uintptr_t)&__heap_base;
}

// nodes=[x,y,vx,vy,inverseMass] and edges=[a,b,restLength,gain], Float64.
// Ordered Gauss-Seidel passes mirror the existing JavaScript worker.
__attribute__((visibility("default"))) int project_constraints(
    uint32_t nodes_ptr, uint32_t edges_ptr,
    uint32_t node_count, uint32_t edge_count, uint32_t iterations) {
  if (!nodes_ptr || (edge_count && !edges_ptr) || node_count > 1000000U || edge_count > 4000000U) return -1;
  if (iterations < 1U) iterations = 1U;
  if (iterations > 32U) iterations = 32U;
  double* nodes = (double*)(uintptr_t)nodes_ptr;
  double* edges = (double*)(uintptr_t)edges_ptr;
  for (uint32_t iteration = 0; iteration < iterations; ++iteration) {
    for (uint32_t e = 0; e < edge_count; ++e) {
      const uint32_t q = e * 4U;
      const int32_t ai = (int32_t)edges[q], bi = (int32_t)edges[q + 1U];
      if (ai < 0 || bi < 0 || (uint32_t)ai >= node_count || (uint32_t)bi >= node_count) continue;
      const uint32_t a = (uint32_t)ai * 5U, b = (uint32_t)bi * 5U;
      const double dx = nodes[b] - nodes[a], dy = nodes[b + 1U] - nodes[a + 1U];
      const double dist = __builtin_sqrt(dx * dx + dy * dy);
      if (dist < 1e-5) continue;
      const double wa = nodes[a + 4U] > 0.0 ? nodes[a + 4U] : 0.0;
      const double wb = nodes[b + 4U] > 0.0 ? nodes[b + 4U] : 0.0;
      const double sum = wa + wb;
      if (sum <= 0.0) continue;
      const double gain = clampd(edges[q + 3U], 0.0, 1.5);
      const double rest = edges[q + 2U] > 0.001 ? edges[q + 2U] : 0.001;
      const double error = (dist - rest) / dist;
      const double corrX = dx * error * gain, corrY = dy * error * gain;
      nodes[a] += corrX * wa / sum; nodes[a + 1U] += corrY * wa / sum;
      nodes[b] -= corrX * wb / sum; nodes[b + 1U] -= corrY * wb / sum;
    }
  }
  for (uint32_t e = 0; e < edge_count; ++e) {
    const uint32_t q = e * 4U;
    const int32_t ai = (int32_t)edges[q], bi = (int32_t)edges[q + 1U];
    if (ai < 0 || bi < 0 || (uint32_t)ai >= node_count || (uint32_t)bi >= node_count) continue;
    const uint32_t a = (uint32_t)ai * 5U, b = (uint32_t)bi * 5U;
    const double dx = nodes[b] - nodes[a], dy = nodes[b + 1U] - nodes[a + 1U];
    const double dist = __builtin_sqrt(dx * dx + dy * dy);
    if (dist < 1e-5) continue;
    const double nx = dx / dist, ny = dy / dist;
    const double gain = clampd(edges[q + 3U], 0.0, 1.5);
    const double rel = ((nodes[b + 2U] - nodes[a + 2U]) * nx +
                        (nodes[b + 3U] - nodes[a + 3U]) * ny) * gain;
    if (!(rel == rel) || (rel > -1e-5 && rel < 1e-5)) continue;
    const double wa = nodes[a + 4U] > 0.0 ? nodes[a + 4U] : 0.0;
    const double wb = nodes[b + 4U] > 0.0 ? nodes[b + 4U] : 0.0;
    const double sum = wa + wb;
    if (sum <= 0.0) continue;
    nodes[a + 2U] += nx * rel * wa / sum; nodes[a + 3U] += ny * rel * wa / sum;
    nodes[b + 2U] -= nx * rel * wb / sum; nodes[b + 3U] -= ny * rel * wb / sum;
  }
  return 0;
}

// bodies=[x,y,vx,vy,ax,ay,angle,omega,alpha,damping,maxVX,maxVY,maxOmega], Float32.
__attribute__((visibility("default"))) int integrate_bodies(uint32_t data_ptr, uint32_t count, double dt) {
  if (!data_ptr || count > 1000000U) return -1;
  float* data = (float*)(uintptr_t)data_ptr;
  const double step = clampd(dt, 0.0, 0.05);
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t b = i * 13U;
    const double maxVX = data[b + 10U] > 0.0f ? data[b + 10U] : 0.0;
    const double maxVY = data[b + 11U] > 0.0f ? data[b + 11U] : 0.0;
    const double maxOmega = data[b + 12U] > 0.0f ? data[b + 12U] : 0.0;
    const double vx = clampd((double)data[b + 2U] + (double)data[b + 4U] * step, -maxVX, maxVX);
    const double vy = clampd((double)data[b + 3U] + (double)data[b + 5U] * step, -maxVY, maxVY);
    const double damping = clampd(data[b + 9U], 0.0, 1.0);
    const double omegaStep = clampd((double)data[b + 7U] + (double)data[b + 8U] * step, -maxOmega, maxOmega);
    const double omega = omegaStep * damping;
    data[b + 2U] = (float)vx; data[b + 3U] = (float)vy;
    data[b] = (float)((double)data[b] + vx * step);
    data[b + 1U] = (float)((double)data[b + 1U] + vy * step);
    data[b + 7U] = (float)omega;
    data[b + 6U] = (float)((double)data[b + 6U] + omega * step);
  }
  return 0;
}

__attribute__((visibility("default"))) uint32_t abi_version() { return 1U; }
}
