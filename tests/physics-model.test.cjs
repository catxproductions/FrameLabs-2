'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../js/physics-model.js'), 'utf8');
function loadModel() {
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'physics-model.js' });
  return window.FrameLabPhysicsModel;
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
