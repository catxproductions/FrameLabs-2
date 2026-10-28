'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const materialsSource = fs.readFileSync(path.resolve(__dirname, '../js/materials.js'), 'utf8');
const physicsSource = fs.readFileSync(path.resolve(__dirname, '../js/physics-model.js'), 'utf8');
const mainSource = fs.readFileSync(path.resolve(__dirname, '../js/main.js'), 'utf8');

function loadLibraries() {
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const window = {
    CustomEvent,
    dispatchedEvents: [],
    dispatchEvent(event) {
      this.dispatchedEvents.push(event);
      return true;
    }
  };

  const context = { window, CustomEvent };
  vm.runInNewContext(materialsSource, context, { filename: 'materials.js' });
  vm.runInNewContext(physicsSource, context, { filename: 'physics-model.js' });

  return {
    window,
    materials: window.FrameLabMaterials,
    model: window.FrameLabPhysicsModel
  };
}

function loadModel() {
  return loadLibraries().model;
}

test('material-pair friction changes smoothly with sliding speed and moisture', () => {
  const model = loadModel();
  const slowDry = model.contactResponse('wood', 'concrete', 0, 0);
  const fastDry = model.contactResponse('wood', 'concrete', 4, 0);
  const slowWet = model.contactResponse('wood', 'concrete', 0, 1);
  assert.ok(slowDry.dynamicFriction > fastDry.dynamicFriction);
  assert.ok(slowWet.dynamicFriction < slowDry.dynamicFriction);
  assert.ok(fastDry.restitution <= slowDry.restitution);
  assert.ok(Number.isFinite(slowWet.dynamicFriction));
});

test('submersion is clamped and buoyancy is density dependent', () => {
  const model = loadModel();
  assert.equal(model.submergedFraction(0, 1, -1), 0);
  assert.equal(model.submergedFraction(0, 1, 1), 1);
  assert.equal(model.submergedFraction(0, 2, 1), 0.5);
  const wood = model.environmentAcceleration({ material: 'wood', mass: 1, area: .2, submerged: 1, gravity: 9.81 });
  const steel = model.environmentAcceleration({ material: 'steel', mass: 1, area: .2, submerged: 1, gravity: 9.81 });
  assert.ok(wood.ay > 0, 'low-density wood receives upward net buoyancy in the illustrative fluid model');
  assert.ok(steel.ay < 0, 'dense steel remains negatively accelerated under full submersion');
  assert.ok(steel.dragStrength >= 0);
});

test('quality selection and moisture shading return bounded, deterministic results', () => {
  const model = loadModel();
  assert.equal(model.chooseQualityTier({ cpuMs: 20, cores: 8, memoryGB: 16 }), 'entry');
  assert.equal(model.chooseQualityTier({ cpuMs: 3, cores: 8, memoryGB: 16 }), 'enthusiast');
  assert.equal(model.chooseQualityTier({ cpuMs: 8, cores: 4, memoryGB: 4 }), 'balanced');
  assert.notEqual(model.shadeForMoisture('#ffffff', 1), '#ffffff');
  assert.equal(model.shadeForMoisture('#abcdef', 0), '#abcdef');
  assert.equal(model.shadeForMoisture('not-a-color', 1), 'not-a-color');
});


test('structural wind demand is speed-squared, gust-aware, and exposure/height dependent', () => {
  const { model, materials: library } = loadLibraries();
  const materials = library.materials;
  const demand = (speedKph, height, exposure = 1.35, kind = 'column', gustFactor = 1) =>
    model.windMemberDemand({ speedKph, height, exposure, kind, gustFactor });
  assert.equal(demand(0, 1), 0, 'calm conditions add no wind demand');
  const halfSpeed = demand(50, 1, 1, 'column', 1);
  const fullSpeed = demand(100, 1, 1, 'column', 1);
  assert.ok(Math.abs(fullSpeed / halfSpeed - 4) < 1e-9, 'doubling wind speed quadruples the pressure-based demand');
  assert.ok(demand(100, 1) > demand(100, 0), 'higher members receive greater wind demand');
  assert.ok(demand(100, 1, 1.35) > demand(100, 1, 0.38), 'windward exposure increases structural demand');
  assert.ok(demand(100, 1, 1.35, 'beam') > demand(100, 1, 1.35, 'beam', 0.7), 'gust strength affects demand');
  const severeWindColumn = demand(100, 1, 1.35, 'column', 1.24);
  assert.ok(severeWindColumn > materials.wood.column.capacity, 'severe wind can overload a weak wood column');
  assert.ok(severeWindColumn < materials.steel.column.capacity, 'the same wind load alone remains below built-in steel column capacity');
  assert.ok(Number.isFinite(model.windMemberDemand({ speedKph: 1000, height: 5, exposure: 9, kind: 'unknown' })), 'unexpected inputs remain bounded');
});


test('component mass properties calculate COM and inertia about COM and a support pivot', () => {
  const model = loadModel();
  const elements = [
    { mass: 1, x: 0, y: 0 },
    { mass: 1, x: 2, y: 0 }
  ];
  const com = model.calculateMassProperties2D(elements);
  assert.equal(com.mass, 2);
  assert.equal(com.comX, 1);
  assert.equal(com.comY, 0);
  assert.equal(com.inertiaAboutCOM, 2);
  assert.equal(com.inertiaAboutPivot, 2, 'without a pivot, inertia is reported about the COM');

  const supported = model.calculateMassProperties2D(elements, { x: 0, y: 0 });
  assert.equal(supported.inertiaAboutPivot, 4, 'parallel-axis term is included for support-pivot rotation');

  const member = model.calculateMassProperties2D([
    { mass: 3, x: 1, y: 2, intrinsicInertia: 4 }
  ]);
  assert.equal(member.inertiaAboutCOM, 4, 'a member contributes its own centroidal inertia');

  const invalid = model.calculateMassProperties2D([
    { mass: -4, x: 0, y: 0 },
    { mass: 2, x: Infinity, y: 0 },
    { mass: 0, x: 1, y: 1 }
  ]);
  assert.equal(invalid.mass, 0, 'invalid or non-positive mass samples are ignored');
  assert.equal(invalid.inertiaAboutCOM, 0);
});


test('asymmetric support loss creates a gravity-driven inward fold toward the weak side', () => {
  const model = loadModel();
  const weakRight = model.calculateFoldResponse({
    mass: 20, comX: 5, pivotX: 1, inertia: 200,
    supportLoss: 0.35, supportCenterShift: -0.6,
    lostSupportCount: 2, maxSupportUtilization: 0.55, storyWidth: 3.15
  });
  assert.equal(weakRight.active, true);
  assert.equal(weakRight.direction, 1, 'a support-capacity shift left indicates weakness on the right');
  assert.ok(weakRight.torque < 0, 'the surviving left pivot produces clockwise torque toward the weak right side');
  assert.ok(weakRight.angularAcceleration < 0);

  const weakLeft = model.calculateFoldResponse({
    mass: 20, comX: 5, pivotX: 9, inertia: 200,
    supportLoss: 0.35, supportCenterShift: 0.6,
    lostSupportCount: 2, maxSupportUtilization: 0.55, storyWidth: 3.15
  });
  assert.equal(weakLeft.active, true);
  assert.equal(weakLeft.direction, -1);
  assert.ok(weakLeft.torque > 0, 'the surviving right pivot produces counter-clockwise torque toward the weak left side');

  const symmetric = model.calculateFoldResponse({
    mass: 20, comX: 5, pivotX: 1, inertia: 200,
    supportLoss: 0.35, supportCenterShift: 0,
    lostSupportCount: 2, maxSupportUtilization: 0.55, storyWidth: 3.15
  });
  assert.equal(symmetric.active, false, 'symmetric support loss alone does not invent a preferred folding direction');
});

test('one missing support member does not trigger folding in a strong redundant frame', () => {
  const model = loadModel();
  const strongFrame = model.calculateFoldResponse({
    mass: 20, comX: 5, pivotX: 1, inertia: 240,
    supportLoss: 0.32, supportCenterShift: -0.50,
    lostSupportCount: 1, maxSupportUtilization: 0.55,
    storyWidth: 3.15
  });
  assert.equal(strongFrame.active, false,
    'one missing member and lightly loaded survivors should not induce a fold');

  const criticalFrame = model.calculateFoldResponse({
    mass: 20, comX: 5, pivotX: 1, inertia: 240,
    supportLoss: 0.32, supportCenterShift: -0.50,
    lostSupportCount: 1, maxSupportUtilization: 0.96,
    storyWidth: 3.15
  });
  assert.equal(criticalFrame.active, true,
    'a single support loss may fold the structure when remaining supports are near overload');
});


test('detached falling members use local demand instead of unsupported-only overload', () => {
  const model = loadModel();
  const strongMember = model.calculateDetachedMemberUtilization({
    demand: 5,
    capacity: 10,
    integrity: 1,
    connectionFactor: 1,
    momentUtilization: 0.25
  });
  assert.equal(strongMember, 0.5,
    'lack of a ground connection must not automatically force utilization above 100%');

  const weakenedMember = model.calculateDetachedMemberUtilization({
    demand: 5,
    capacity: 10,
    integrity: 0.5,
    connectionFactor: 0.5,
    momentUtilization: 0.25
  });
  assert.equal(weakenedMember, 2,
    'actual reduced capacity must still cause overload while falling');

  const overloadedBeam = model.calculateDetachedMemberUtilization({
    demand: 2,
    capacity: 10,
    integrity: 1,
    connectionFactor: 1,
    momentUtilization: 1.25
  });
  assert.equal(overloadedBeam, 1.25,
    'genuine bending demand remains able to break a detached beam');
});

test('whole-assembly rotation does not count as local column bending', () => {
  const model = loadModel();
  const upright = model.columnTiltRelativeToAssembly(0, 1, 0);
  const rotatedRight = model.columnTiltRelativeToAssembly(-1, 0, Math.PI / 2);
  const locallyBent = model.columnTiltRelativeToAssembly(-0.5, 0.866, 0);
  assert.ok(upright < 1e-9);
  assert.ok(rotatedRight < 1e-9,
    'a column that rotates together with its detached frame keeps its integrity');
  assert.ok(locallyBent > 0.4,
    'local bending relative to the assembly still produces a failure signal');
});


test('debris settles only on supported surfaces and only ground settling is permanent', () => {
  const model = loadModel();
  const lowSpeed = {
    relativeSpeed: 0.1, relativeHorizontalSpeed: 0.05,
    angularSpeed: 0.01, kind: 'beam', angle: 0
  };
  assert.equal(model.canDebrisSettle({ ...lowSpeed, surfaceSupported: true }), true,
    'low-speed contact with a supported member can sleep temporarily');
  assert.equal(model.canDebrisSettle({ ...lowSpeed, surfaceSupported: false }), false,
    'an unsupported/falling surface cannot hold sleeping debris');
  assert.equal(model.canDebrisSettle({ ...lowSpeed, surfaceSupported: true, onSimulationGround: true }), true,
    'the simulation ground permits permanent settling');
  assert.equal(model.canDebrisSettle({
    ...lowSpeed, surfaceSupported: true, relativeSpeed: 1
  }), false, 'high-speed impacts remain dynamic');
  assert.equal(model.canDebrisSettle({
    ...lowSpeed, surfaceSupported: true, kind: 'column', angle: Math.PI / 2
  }), false, 'a vertical column fragment must not sleep upright');
});


test('unified falling assemblies ignore gravity-only load-path penalties', () => {
  const model = loadModel();
  const freeFall = model.calculateUnifiedAssemblyStress({
    capacity: 100, integrity: 1, connectionFactor: 1,
    windDemand: 0, impactStress: 0, axialStrain: 0, relativeAngle: 0
  });
  assert.equal(freeFall.utilization, 0,
    'an unsupported but rigidly falling assembly has no internal stress from its own weight');
  assert.equal(freeFall.overstressed, false);

  const windLoaded = model.calculateUnifiedAssemblyStress({
    capacity: 100, integrity: 1, connectionFactor: 1,
    windDemand: 125, impactStress: 0, axialStrain: 0, relativeAngle: 0
  });
  assert.equal(windLoaded.utilization, 1.25,
    'real external wind demand still stresses the falling members');

  const collisionLoaded = model.calculateUnifiedAssemblyStress({
    capacity: 100, integrity: 1, connectionFactor: 1,
    windDemand: 0, impactStress: 2, axialStrain: 0, relativeAngle: 0
  });
  assert.equal(collisionLoaded.utilization, 1.6,
    'collision stress can trigger damage while the assembly is falling');

  const locallyBent = model.calculateUnifiedAssemblyStress({
    capacity: 100, integrity: 1, connectionFactor: 1,
    windDemand: 0, impactStress: 0, axialStrain: 0.02, relativeAngle: 0.48
  });
  assert.equal(locallyBent.overstressed, true,
    'member deformation relative to the assembly can trigger failure');
});

test('main physics tags intact floating assemblies and bypasses gravity-only failure heuristics', () => {
  assert.match(mainSource, /e\.unifiedAssemblyId=null;e\.isUnifiedFallingAssembly=false/);
  assert.match(mainSource, /if\(assembly\?\.isFloating\)\{\s*e\.unifiedAssemblyId=assembly\.key;\s*e\.isUnifiedFallingAssembly=true;/);
  assert.match(mainSource, /if\(e\.isUnifiedFallingAssembly\)\{\s*\/\/ Static span analysis assumes gravity load is carried to ground/);
  assert.match(mainSource, /if\(e\.isUnifiedFallingAssembly\)\{\s*\/\/ Skip invented world-vertical joint loads/);
  assert.match(mainSource, /if\(e\.isUnifiedFallingAssembly\)\{\s*\/\/ Free fall removes the assembly's own weight/);
});


test('unified falling assembly joints do not yield below actual normalized stress', () => {
  assert.match(mainSource, /const ratio=clamp\(Math\.max\(stress\.utilization,conn\.pendingBreakUntil!=null\?\(Number\(conn\.lastDemandRatio\)\|\|0\):0\),0,4\)/);
  assert.match(mainSource, /if\(ratio<=1&&conn\.pendingBreakUntil==null\)continue/);
  assert.doesNotMatch(mainSource, /stress\.utilization\*1\.18/,
    'falling assembly joint demand must not be artificially amplified');
});
