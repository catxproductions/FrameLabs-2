/* FrameLab's testable, reduced-order material and environment model.
   These parameters are illustrative game units, not calibrated engineering data. */
(() => {
  'use strict';
  const MATERIALS = Object.freeze({
    steel:     Object.freeze({ density: 7.8, staticFriction: .50, dynamicFriction: .30, restitution: .16, wetSensitivity: .78, elasticity: .78 }),
    concrete:  Object.freeze({ density: 2.35, staticFriction: .88, dynamicFriction: .64, restitution: .08, wetSensitivity: .28, elasticity: .25 }),
    wood:      Object.freeze({ density: .68, staticFriction: .76, dynamicFriction: .49, restitution: .12, wetSensitivity: .62, elasticity: .58 }),
    flammable:Object.freeze({ density: .86, staticFriction: .63, dynamicFriction: .41, restitution: .10, wetSensitivity: .48, elasticity: .44 }),
    explosive: Object.freeze({ density: 1.12, staticFriction: .57, dynamicFriction: .37, restitution: .12, wetSensitivity: .42, elasticity: .38 })
  });
  const GROUND = MATERIALS.concrete;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function material(name) { return MATERIALS[name] || GROUND; }

  // Static grip decays into kinetic friction as relative speed rises. Moisture has
  // material-specific sensitivity, so wet wood/steel changes more than concrete.
  function contactResponse(materialA, materialB, relativeSpeed = 0, moisture = 0) {
    const a = material(materialA), b = material(materialB);
    const speed = Math.max(0, finite(relativeSpeed));
    const wet = clamp(finite(moisture), 0, 1);
    const dryStatic = (a.staticFriction + b.staticFriction) * .5;
    const dryDynamic = (a.dynamicFriction + b.dynamicFriction) * .5;
    const speedCurve = Math.exp(-1.35 * speed);
    const wetSensitivity = (a.wetSensitivity + b.wetSensitivity) * .5;
    const wetFactor = 1 - wet * wetSensitivity * .56;
    const friction = clamp((dryDynamic + (dryStatic - dryDynamic) * speedCurve) * wetFactor, .035, 1.15);
    const restitution = clamp(((a.restitution + b.restitution) * .5) * Math.exp(-.045 * speed) * (1 - .25 * wet), .02, .30);
    return {
      staticFriction: clamp(dryStatic * wetFactor, .03, 1.2),
      dynamicFriction: friction,
      restitution,
      density: (a.density + b.density) * .5,
      elasticity: (a.elasticity + b.elasticity) * .5
    };
  }

  function submergedFraction(bottom, top, waterSurface) {
    const lo = finite(bottom), hi = Math.max(lo + 1e-6, finite(top, lo + 1e-6));
    const water = finite(waterSurface, -Infinity);
    if (!Number.isFinite(water) || water <= lo) return 0;
    if (water >= hi) return 1;
    return clamp((water - lo) / (hi - lo), 0, 1);
  }

  // Simplified quadratic air/water drag plus buoyancy. Y is positive upward.
  // area and mass are normalized in FrameLab world units, not SI-calibrated values.
  function environmentAcceleration({ vx = 0, vy = 0, area = .1, mass = .2, material: materialName = 'steel', submerged = 0, gravity = 9.81 } = {}) {
    const xVelocity = finite(vx), yVelocity = finite(vy), g = Math.max(0, finite(gravity, 9.81));
    const a = Math.max(.02, finite(area, .1)), m = Math.max(.05, finite(mass, .2));
    const wet = clamp(finite(submerged), 0, 1), density = Math.max(.2, material(materialName).density);
    const speed = Math.hypot(xVelocity, yVelocity);
    const areaMass = a / m;
    const airDrag = .0125 * areaMass * (1 - wet) * speed;
    const waterDrag = .095 * areaMass * wet * speed;
    return {
      ax: clamp(-xVelocity * (airDrag + waterDrag), -35, 35),
      ay: clamp(-g + g * wet / density - yVelocity * (airDrag + waterDrag), -35, 35),
      submerged: wet,
      buoyancy: g * wet / density,
      dragStrength: airDrag + waterDrag
    };
  }

  function chooseQualityTier({ cpuMs = 8, cores = 4, memoryGB = 4, gpuExpected = false, gpuMs = null } = {}) {
    const cpu = Math.max(0, finite(cpuMs, 8));
    const hwCores = Math.max(1, finite(cores, 4));
    const memory = Math.max(.5, finite(memoryGB, 4));
    const gpuTime = gpuMs == null ? null : Math.max(0, finite(gpuMs, 1000));
    if (cpu > 15 || hwCores <= 2 || memory <= 2 || (gpuExpected && gpuTime != null && gpuTime > 45)) return 'entry';
    if (cpu < 5.5 && hwCores >= 8 && memory >= 8 && (!gpuExpected || (gpuTime != null && gpuTime < 24))) return 'enthusiast';
    return 'balanced';
  }

  function shadeForMoisture(hex, moisture) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const wet = clamp(finite(moisture), 0, 1);
    const darken = 1 - .19 * wet;
    const value = [1, 3, 5].map((offset) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * darken));
    return `#${value.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  window.FrameLabPhysicsModel = Object.freeze({
    materials: MATERIALS,
    contactResponse,
    submergedFraction,
    environmentAcceleration,
    chooseQualityTier,
    shadeForMoisture
  });
})();
