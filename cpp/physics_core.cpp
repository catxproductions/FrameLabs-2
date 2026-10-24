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


// Debris body layout (17 Float64 values):
// x,y,vx,vy,angle,omega,length,thickness,mass,settled,durability,integrity,
// fragmentDepth,staticFriction,dynamicFriction,restitution,wetSensitivity.
// Each candidate pair is two uint32 indexes. Each event is
// [collided, normalImpulse, closingSpeed, impactEnergy].
static inline double debris_radius(const double* d, double ax, double ay) {
  const double c = __builtin_cos(d[4]), s = __builtin_sin(d[4]);
  return __builtin_fabs(c * ax + s * ay) * d[6] * 0.5 +
         __builtin_fabs(-s * ax + c * ay) * d[7] * 0.5;
}
static inline double debris_inverse_mass(const double* d) {
  const double mass = d[8] > 0.025 ? d[8] : 0.025;
  return (d[9] != 0.0 ? 0.12 : 1.0) / mass;
}
static inline double debris_inertia(const double* d) {
  const double inertia = d[8] * (d[6] * d[6] + d[7] * d[7]) / 12.0;
  return inertia > 0.01 ? inertia : 0.01;
}
static inline void debris_point_velocity(const double* d, double rx, double ry, double* vx, double* vy) {
  *vx = d[2] - d[5] * ry;
  *vy = d[3] + d[5] * rx;
}

__attribute__((visibility("default"))) int resolve_debris_pairs(
    uint32_t bodies_ptr, uint32_t pairs_ptr, uint32_t events_ptr,
    uint32_t body_count, uint32_t pair_count, double moisture) {
  const uint32_t BODY_STRIDE = 17U, EVENT_STRIDE = 4U;
  if (!bodies_ptr || (pair_count && (!pairs_ptr || !events_ptr)) ||
      body_count > 1000000U || pair_count > 4000000U) return -1;
  double* bodies = (double*)(uintptr_t)bodies_ptr;
  uint32_t* pairs = (uint32_t*)(uintptr_t)pairs_ptr;
  double* events = (double*)(uintptr_t)events_ptr;
  const double wet = clampd(moisture, 0.0, 1.0);

  for (uint32_t pairIndex = 0; pairIndex < pair_count; ++pairIndex) {
    const uint32_t ev = pairIndex * EVENT_STRIDE;
    events[ev] = events[ev + 1U] = events[ev + 2U] = events[ev + 3U] = 0.0;
    const uint32_t ia = pairs[pairIndex * 2U], ib = pairs[pairIndex * 2U + 1U];
    if (ia >= body_count || ib >= body_count || ia == ib) continue;
    double* a = bodies + ia * BODY_STRIDE;
    double* b = bodies + ib * BODY_STRIDE;
    if (a[9] != 0.0 && b[9] != 0.0) continue;

    const double ca = __builtin_cos(a[4]), sa = __builtin_sin(a[4]);
    const double cb = __builtin_cos(b[4]), sb = __builtin_sin(b[4]);
    const double hax = (__builtin_fabs(ca) * a[6] + __builtin_fabs(sa) * a[7]) * 0.5;
    const double hay = (__builtin_fabs(sa) * a[6] + __builtin_fabs(ca) * a[7]) * 0.5;
    const double hbx = (__builtin_fabs(cb) * b[6] + __builtin_fabs(sb) * b[7]) * 0.5;
    const double hby = (__builtin_fabs(sb) * b[6] + __builtin_fabs(cb) * b[7]) * 0.5;
    if (a[0] + hax < b[0] - hbx || b[0] + hbx < a[0] - hax ||
        a[1] + hay < b[1] - hby || b[1] + hby < a[1] - h ay) continue;

    const double dx = b[0] - a[0], dy = b[1] - a[1];
    const double rvCenterX = b[2] - a[2], rvCenterY = b[3] - a[3];
    const double axes[8] = {ca, sa, -sa, ca, cb, sb, -sb, cb};
    double minOverlap = 1.0e300, nx = 0.0, ny = 0.0;
    double closingOverlap = 1.0e300, closingNx = 0.0, closingNy = 0.0;
    bool separated = false, haveClosingAxis = false;
    for (uint32_t axisIndex = 0; axisIndex < 4U; ++axisIndex) {
      const double ax = axes[axisIndex * 2U], ay = axes[axisIndex * 2U + 1U];
      const double projection = dx * ax + dy * ay;
      const double overlap = debris_radius(a, ax, ay) + debris_radius(b, ax, ay) - __builtin_fabs(projection);
      if (overlap <= 0.0) { separated = true; break; }
      const double sign = projection >= 0.0 ? 1.0 : -1.0;
      const double cx = ax * sign, cy = ay * sign;
      if (overlap < minOverlap) { minOverlap = overlap; nx = cx; ny = cy; }
      if (rvCenterX * cx + rvCenterY * cy < -0.015 && overlap < closingOverlap) {
        closingOverlap = overlap; closingNx = cx; closingNy = cy; haveClosingAxis = true;
      }
    }
    if (separated || minOverlap >= 1.0e299) continue;
    if (haveClosingAxis) { minOverlap = closingOverlap; nx = closingNx; ny = closingNy; }

    const double imA = debris_inverse_mass(a), imB = debris_inverse_mass(b), invSum = imA + imB;
    if (invSum <= 0.0) continue;
    const double correction = (minOverlap > 0.006 ? minOverlap - 0.006 : 0.0) * 0.72 / invSum;
    a[0] -= nx * correction * imA; b[0] += nx * correction * imB;
    a[1] -= ny * correction * imA; b[1] += ny * correction * imB;

    const double tangentX = -ny, tangentY = nx;
    const double raN = debris_radius(a, nx, ny), rbN = debris_radius(b, nx, ny);
    const double tangentOffset = (dx * tangentX + dy * tangentY) * 0.5;
    const double contactX = (a[0] + nx * raN + tangentX * tangentOffset +
                             b[0] - nx * rbN) * 0.5;
    const double contactY = (a[1] + ny * raN + tangentY * tangentOffset +
                             b[1] - ny * rbN) * 0.5;
    const double rAx = contactX - a[0], rAy = contactY - a[1];
    const double rBx = contactX - b[0], rBy = contactY - b[1];
    double vaX, vaY, vbX, vbY;
    debris_point_velocity(a, rAx, rAy, &vaX, &vaY);
    debris_point_velocity(b, rBx, rBy, &vbX, &vbY);
    double rvx = vbX - vaX, rvy = vbY - vaY;
    const double vn = rvx * nx + rvy * ny;
    double normalImpulse = 0.0;

    if (vn < 0.0) {
      const double speed = __builtin_fabs(vn);
      const double dryStatic = (a[13] + b[13]) * 0.5;
      const double dryDynamic = (a[14] + b[14]) * 0.5;
      const double wetSensitivity = (a[16] + b[16]) * 0.5;
      const double wetFactor = 1.0 - wet * wetSensitivity * 0.56;
      const double speedCurve = __builtin_exp(-1.35 * speed);
      const double dynamicFriction = clampd((dryDynamic + (dryStatic - dryDynamic) * speedCurve) * wetFactor, 0.035, 1.15);
      const double restitution = clampd(((a[15] + b[15]) * 0.5) *
          __builtin_exp(-0.045 * speed) * (1.0 - 0.25 * wet), 0.02, 0.30);
      const double iaMoment = debris_inertia(a), ibMoment = debris_inertia(b);
      const double caTerm = rAx * ny - rAy * nx, cbTerm = rBx * ny - rBy * nx;
      const double denom = imA + imB + caTerm * caTerm / iaMoment + cbTerm * cbTerm / ibMoment;
      if (denom > 1e-8) {
        const double maxImpulseCandidate = (a[8] + b[8]) * 15.0 * 1.8;
        const double maxImpulse = maxImpulseCandidate > 0.1 ? maxImpulseCandidate : 0.1;
        normalImpulse = clampd(-(1.0 + restitution) * vn / denom, 0.0, maxImpulse);
        a[2] -= normalImpulse * imA * nx; a[3] -= normalImpulse * imA * ny;
        b[2] += normalImpulse * imB * nx; b[3] += normalImpulse * imB * ny;
        a[5] = clampd(a[5] - normalImpulse * caTerm / iaMoment, -3.4, 3.4);
        b[5] = clampd(b[5] + normalImpulse * cbTerm / ibMoment, -3.4, 3.4);

        debris_point_velocity(a, rAx, rAy, &vaX, &vaY);
        debris_point_velocity(b, rBx, rBy, &vbX, &vbY);
        rvx = vbX - vaX; rvy = vbY - vaY;
        const double vt = rvx * tangentX + rvy * tangentY;
        const double ta = rAx * tangentY - rAy * tangentX;
        const double tb = rBx * tangentY - rBy * tangentX;
        const double tDenom = imA + imB + ta * ta / iaMoment + tb * tb / ibMoment;
        double jt = tDenom > 1e-8 ? -vt / tDenom : 0.0;
        const double frictionLimit = normalImpulse * clampd(dynamicFriction, 0.06, 0.82);
        jt = clampd(jt, -frictionLimit, frictionLimit);
        a[2] -= jt * imA * tangentX; a[3] -= jt * imA * tangentY;
        b[2] += jt * imB * tangentX; b[3] += jt * imB * tangentY;
        a[5] = clampd(a[5] - jt * ta / iaMoment, -3.4, 3.4);
        b[5] = clampd(b[5] + jt * tb / ibMoment, -3.4, 3.4);
      }
    }

    if (normalImpulse > 0.3) {
      if (a[9] != 0.0) a[9] = 0.0;
      if (b[9] != 0.0) b[9] = 0.0;
    }
    const double closing = vn < 0.0 ? -vn : 0.0;
    const double reducedMass = invSum > 0.0 ? 1.0 / invSum : 0.0;
    const double energy = 0.5 * reducedMass * closing * closing;
    a[2] = clampd(a[2], -15.0, 15.0); b[2] = clampd(b[2], -15.0, 15.0);
    a[3] = clampd(a[3], -15.0, 15.0); b[3] = clampd(b[3], -15.0, 15.0);
    events[ev] = 1.0;
    events[ev + 1U] = normalImpulse;
    events[ev + 2U] = closing;
    events[ev + 3U] = energy;
  }
  return 0;
}

__attribute__((visibility("default"))) uint32_t abi_version() { return 1U; }
}
