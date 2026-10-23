'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const materialsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/materials.js'),
  'utf8'
);
const physicsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/physics-model.js'),
  'utf8'
);

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
    physics: window.FrameLabPhysicsModel
  };
}

test('built-in materials keep their stable ids and behavior flags', () => {
  const { materials } = loadLibraries();

  assert.equal(materials.getMaterialIds().join(','), 'steel,concrete,wood,flammable,explosive');

  assert.equal(materials.materials.steel.isExplosive, false);
  assert.equal(materials.materials.steel.isFlamable, false);
  assert.equal(materials.materials.concrete.isExplosive, false);
  assert.equal(materials.materials.wood.isFlamable, false);

  assert.equal(materials.materials.flammable.isFlamable, true);
  assert.equal(materials.materials.flammable.isFlammable, true);
  assert.equal(materials.materials.flammable.isExplosive, false);

  assert.equal(materials.materials.explosive.isExplosive, true);
  assert.equal(materials.materials.explosive.isFlamable, false);
});

test('addMaterial supports fire, explosive, both, neither, and spelling alias', () => {
  const { materials } = loadLibraries();

  materials.addMaterial({
    id: 'painted-wood',
    basedOn: 'wood',
    isFlamable: true,
    isExplosive: false
  });

  materials.addMaterial({
    id: 'dual-material',
    basedOn: 'concrete',
    isFlammable: true,
    isExplosive: true
  });

  materials.addMaterial({
    id: 'non-reactive',
    basedOn: 'concrete',
    isFlamable: false,
    isExplosive: false
  });

  assert.equal(materials.isFlammable('painted-wood'), true);
  assert.equal(materials.isExplosive('painted-wood'), false);
  assert.equal(materials.isFlammable('dual-material'), true);
  assert.equal(materials.isExplosive('dual-material'), true);
  assert.equal(materials.materials['dual-material'].isFlamable, true);
  assert.equal(materials.isFlammable('non-reactive'), false);
  assert.equal(materials.isExplosive('non-reactive'), false);

  // Unknown ids should not accidentally gain either behavior.
  assert.equal(materials.isFlammable('missing-material'), false);
  assert.equal(materials.isExplosive('missing-material'), false);
});

test('new materials inherit omitted values and can override individual properties', () => {
  const { materials } = loadLibraries();
  const wood = materials.materials.wood;

  const lightWood = materials.addMaterial({
    id: 'light-wood',
    label: 'Light wood',
    basedOn: 'wood',
    color: '#abcdef',
    column: { mass: 0.1, capacity: 7 }
  });

  assert.equal(lightWood.label, 'Light wood');
  assert.equal(lightWood.color, '#abcdef');
  assert.equal(lightWood.column.mass, 0.1);
  assert.equal(lightWood.column.capacity, 7);

  // The other component types and physical settings keep the chosen base values.
  assert.equal(lightWood.beam.mass, wood.beam.mass);
  assert.equal(lightWood.slab.capacity, wood.slab.capacity);
  assert.equal(lightWood.staticFriction, wood.staticFriction);
  assert.equal(
    materials.impactResistance['light-wood'].beam,
    materials.impactResistance.wood.beam
  );
});

test('invalid ids, duplicate ids, and unknown bases fail with clear errors', () => {
  const { materials } = loadLibraries();

  assert.throws(
    () => materials.addMaterial({ id: 'Not Allowed!' }),
    /Material id must start with a letter/
  );
  assert.throws(
    () => materials.addMaterial({ id: 'steel' }),
    /already exists/
  );
  assert.throws(
    () => materials.addMaterial({ id: 'mystery', basedOn: 'does-not-exist' }),
    /does not exist/
  );
  assert.throws(
    () => materials.addMaterial(null),
    /needs a material settings object/
  );
});

test('numeric properties are bounded and zero heat weakening is supported', () => {
  const { materials } = loadLibraries();

  const custom = materials.addMaterial({
    id: 'glass-like',
    basedOn: 'concrete',
    isFlamable: false,
    isExplosive: false,
    dynamicFriction: -10,
    restitution: 5,
    heatWeakening: 0,
    heatSensitivity: 0,
    column: { mass: 0, capacity: -2 },
    impactResistance: { column: 500 }
  });

  assert.equal(custom.dynamicFriction, 0.01);
  assert.equal(custom.restitution, 1);
  assert.equal(custom.heatWeakening, 0);
  assert.equal(custom.heatSensitivity, 0);
  assert.equal(custom.column.mass, materials.materials.concrete.column.mass);
  assert.equal(custom.column.capacity, materials.materials.concrete.column.capacity);
  assert.equal(materials.impactResistance['glass-like'].column, 5);
});

test('material JSON exports retain custom behavior flags and impact values', () => {
  const { materials } = loadLibraries();

  materials.addMaterial({
    id: 'dual-glass',
    label: 'Dual glass',
    basedOn: 'concrete',
    isExplosive: true,
    isFlamable: true,
    impactResistance: { column: 0.4, beam: 0.3, slab: 0.2, brace: 0.25 }
  });

  const exportText = JSON.stringify({
    materialLibrary: materials.materials,
    materialImpactResistance: materials.impactResistance
  });
  const imported = JSON.parse(exportText);

  assert.equal(imported.materialLibrary['dual-glass'].isExplosive, true);
  assert.equal(imported.materialLibrary['dual-glass'].isFlamable, true);
  assert.equal(imported.materialLibrary['dual-glass'].isFlammable, true);
  assert.equal(imported.materialImpactResistance['dual-glass'].column, 0.4);
});

test('physics model uses the same shared material library', () => {
  const { materials, physics } = loadLibraries();

  materials.addMaterial({
    id: 'soft-polymer',
    basedOn: 'concrete',
    density: 1.4,
    staticFriction: 0.7,
    dynamicFriction: 0.2,
    restitution: 0.2,
    wetSensitivity: 0.1,
    elasticity: 0.6
  });

  const result = physics.contactResponse('soft-polymer', 'soft-polymer', 0, 0);

  assert.equal(physics.materials, materials.materials);
  assert.equal(result.density, 1.4);
  assert.equal(result.elasticity, 0.6);
  assert.equal(result.staticFriction, 0.7);
  assert.equal(result.dynamicFriction, 0.7);
});
