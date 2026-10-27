/* FrameLab's testable, reduced-order material and environment model.
   These parameters are illustrative game units, not calibrated engineering data. */
(() => {
  'use strict';
  // Structural stats and contact-physics properties share one source of truth.
  // Load materials.js before this file (as index.html does).
  const MATERIAL_LIBRARY = window.FrameLabMaterials;
  if (!MATERIAL_LIBRARY) {
    console.error('FrameLabs 2: materials.js must load before physics-model.js.');
    return;
  }
  const MATERIALS = MATERIAL_LIBRARY.materials;
  const GROUND = MATERIALS.concrete || Object.values(MATERIALS)[0];
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

  // Simplified structural wind demand, calibrated in game units (not engineering
  // pressure units). Wind pressure scales with speed squared; high floors, gusts,
  // windward edges and weaker material capacities therefore matter to failure.
  function windMemberDemand({ speedKph = 0, gustFactor = 1, height = 0, exposure = 1, kind = 'column' } = {}) {
    const speedRatio = clamp(finite(speedKph) / 100, 0, 1);
    if (speedRatio <= 0.0001) return 0;
    const gust = clamp(finite(gustFactor, 1), 0.7, 1.24);
    const elevation = 0.35 + 0.85 * clamp(finite(height), 0, 1);
    const projectedExposure = clamp(finite(exposure, 1), 0, 1.55);
    const typeFactor = { column: 1.15, beam: 0.34, slab: 0.24, brace: 0.38 }[kind] || 0.2;
    return clamp(speedRatio * speedRatio * gust * elevation * projectedExposure * typeFactor * 6.5, 0, 32);
  }


  // Compute two-dimensional rigid-body mass properties for an assembly of
  // point masses and uniform line members. intrinsicInertia is each element's
  // own inertia about its centroid; member rods use m * lengthSquared / 12.
  // Inertia about a support pivot follows the parallel-axis theorem:
  // I_pivot = I_COM + totalMass * distance(COM, pivot)^2.
  function calculateMassProperties2D(elements = [], pivot = null) {
    const samples = [];
    let mass = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (const element of Array.isArray(elements) ? elements : []) {
      const elementMass = finite(element && element.mass, 0);
      const x = finite(element && element.x, NaN);
      const y = finite(element && element.y, NaN);
      if (!(elementMass > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;

      const intrinsicInertia = Math.max(0, finite(
        element.intrinsicInertia ?? element.inertia, 0
      ));
      samples.push({ mass: elementMass, x, y, intrinsicInertia });
      mass += elementMass;
      weightedX += elementMass * x;
      weightedY += elementMass * y;
    }

    const comX = mass > 0 ? weightedX / mass : 0;
    const comY = mass > 0 ? weightedY / mass : 0;
    let inertiaAboutCOM = 0;
    for (const element of samples) {
      const dx = element.x - comX;
      const dy = element.y - comY;
      inertiaAboutCOM += element.intrinsicInertia + element.mass * (dx * dx + dy * dy);
    }

    const hasPivot = pivot && Number.isFinite(Number(pivot.x)) &&
      Number.isFinite(Number(pivot.y));
    const pivotX = hasPivot ? finite(pivot.x, comX) : comX;
    const pivotY = hasPivot ? finite(pivot.y, comY) : comY;
    const offsetX = comX - pivotX;
    const offsetY = comY - pivotY;
    const inertiaAboutPivot = inertiaAboutCOM + mass * (offsetX * offsetX + offsetY * offsetY);

    return {
      mass,
      comX,
      comY,
      inertiaAboutCOM: Math.max(0, inertiaAboutCOM),
      inertiaAboutPivot: Math.max(0, inertiaAboutPivot)
    };
  }



  // Detached assemblies should be judged by their local structural demand,
  // not by a missing path to ground. The latter is a motion/support condition,
  // not proof that every member is already overloaded.
  function calculateDetachedMemberUtilization({
    demand = 0, capacity = 1, integrity = 1,
    connectionFactor = 1, momentUtilization = 0
  } = {}) {
    const remainingIntegrity = clamp(finite(integrity, 1), 0, 1);
    const jointFactor = clamp(finite(connectionFactor, 1), 0.18, 1);
    const effectiveCapacity = Math.max(
      0.01,
      Math.max(0, finite(capacity)) * remainingIntegrity * jointFactor
    );
    const forceUtilization = Math.max(0, finite(demand)) / effectiveCapacity;
    const bendingUtilization = Math.max(0, finite(momentUtilization));
    return Math.max(forceUtilization, bendingUtilization);
  }

  // A column carried by a rotating/falling frame should be tested against the
  // frame's orientation, not the world's vertical. This prevents a rigid-body
  // tumble from being mistaken for local column bending.
  function columnTiltRelativeToAssembly(dx, dy, assemblyAngle = 0) {
    const segmentAngle = Math.atan2(finite(dy), finite(dx));
    const expectedAngle = Math.PI * 0.5 + finite(assemblyAngle);
    const difference = segmentAngle - expectedAngle;
    return Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)));
  }

  // Model a partial-story collapse as a hinge around the surviving support
  // on the opposite side of a damaged support line. centerShift is
  // active-support COM minus nominal-support COM; its sign identifies the weak side.
  function calculateFoldResponse({
    mass = 0, comX = 0, pivotX = 0, inertia = 0,
    supportLoss = 0, supportCenterShift = 0,
    lostSupportCount = 0, maxSupportUtilization = 0,
    storyWidth = 3.15, gravity = 9.81
  } = {}) {
    const totalMass = Math.max(0, finite(mass));
    const center = finite(comX);
    const pivot = finite(pivotX);
    const lost = clamp(finite(supportLoss), 0, 1);
    const shift = finite(supportCenterShift);
    const missingSupports = Math.max(0, Math.trunc(finite(lostSupportCount)));
    const peakUtilization = Math.max(0, finite(maxSupportUtilization));
    const bay = Math.max(0.1, finite(storyWidth, 3.15));
    const g = Math.max(0, finite(gravity, 9.81));
    const shiftMagnitude = Math.abs(shift);

    // A fold is a last-resort failure mode, not the default response to one
    // missing member. Require significant support-capacity loss and imbalance,
    // plus either multiple unavailable supports or near-overload in survivors.
    if (
      totalMass <= 0 ||
      lost < 0.28 ||
      shiftMagnitude < bay * 0.10 ||
      (missingSupports < 2 && peakUtilization < 0.90)
    ) {
      return {
        active: false, direction: 0, severity: 0,
        torque: 0, angularAcceleration: 0
      };
    }

    const imbalance = clamp(shiftMagnitude / (bay * 0.65), 0, 1);
    const overloadFactor = clamp((peakUtilization - 0.75) / 0.5, 0, 1);
    const severity = clamp(lost * 0.62 + imbalance * 0.48 + overloadFactor * 0.10, 0, 1);
    const torque = -(center - pivot) * totalMass * g * severity;
    const angularAcceleration = clamp(
      torque / Math.max(0.25, finite(inertia, 0.25)),
      -4, 4
    );

    return {
      active: severity >= 0.12 && Number.isFinite(torque),
      // Positive direction means the upper block folds toward the right.
      direction: -Math.sign(shift),
      severity,
      torque,
      angularAcceleration
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
    windMemberDemand,
    calculateMassProperties2D,
    calculateFoldResponse,
    calculateDetachedMemberUtilization,
    columnTiltRelativeToAssembly,
    chooseQualityTier,
    shadeForMoisture
  });
})();
