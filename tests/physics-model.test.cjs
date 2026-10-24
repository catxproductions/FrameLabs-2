'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const materialsSource = fs.readFileSync(path.resolve(__dirname, '../js/materials.js'), 'utf8');
const physicsSource = fs.readFileSync(path.resolve(__dirname, '../js/physics-model.js'), 'utf8');

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
  const { model, materials } = loadLibraries();
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
