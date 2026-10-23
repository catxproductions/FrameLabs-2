/*
 * FrameLabs 2 — Material library
 *
 * This file contains the editable material definitions used by the game and
 * the physics model. Values are illustrative game units, not engineering data.
 *
 * BEGINNER TIP:
 * To add a material, copy the example at the bottom, change its id/name/color,
 * and adjust the numbers. Leave basedOn: "concrete" to use concrete as a starting
 * point; the values you provide replace only the properties you specify.
 */
(() => {
  'use strict';

  const COMPONENT_KINDS = Object.freeze(['column', 'beam', 'slab', 'brace']);
  const materials = Object.create(null);
  const impactResistance = Object.create(null);

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positiveOr(value, fallback) {
    const number = numberOr(value, fallback);
    return number > 0 ? number : fallback;
  }

  function between(value, fallback, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, numberOr(value, fallback)));
  }

  function validColor(color, fallback) {
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
      ? color
      : fallback;
  }

  /**
   * Add a material to FrameLabs 2.
   *
   * Required: id, label, color.
   * Optional: basedOn, density/friction/restitution/elasticity values,
   * column/beam/slab/brace { mass, capacity }, and per-part impact resistance.
   * Any omitted values are copied from basedOn (concrete by default).
   */
  function addMaterial(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('addMaterial needs a material settings object.');
    }

    const id = String(options.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
      throw new Error('Material id must start with a letter and use only letters, numbers, "_" or "-".');
    }
    if (materials[id]) {
      throw new Error('A material named "' + id + '" already exists. Choose a different id.');
    }

    const requestedBase = options.basedOn;
    const baseId = requestedBase || (materials.concrete ? 'concrete' : Object.keys(materials)[0]);
    const base = baseId ? materials[baseId] : null;
    const baseImpact = baseId ? impactResistance[baseId] : null;
    if (requestedBase && !base) {
      throw new Error('The basedOn material "' + requestedBase + '" does not exist.');
    }

    const defaultPart = { mass: 0.2, capacity: 8 };
    const parts = {};
    const impacts = {};
    for (const kind of COMPONENT_KINDS) {
      const basePart = base && base[kind] ? base[kind] : defaultPart;
      const suppliedPart = options[kind] || {};
      parts[kind] = Object.freeze({
        mass: positiveOr(suppliedPart.mass, basePart.mass),
        capacity: positiveOr(suppliedPart.capacity, basePart.capacity)
      });
      impacts[kind] = between(
        options.impactResistance && options.impactResistance[kind],
        baseImpact ? baseImpact[kind] : 1,
        0.05,
        5
      );
    }

    const fallbackColor = base ? base.color : '#b4c0d0';
    const material = Object.freeze({
      label: String(options.label || id),
      color: validColor(options.color, fallbackColor),
      // These properties are used by physics-model.js for contact and motion.
      density: positiveOr(options.density, base ? base.density : 1),
      staticFriction: between(options.staticFriction, base ? base.staticFriction : 0.6, 0.01, 2),
      dynamicFriction: between(options.dynamicFriction, base ? base.dynamicFriction : 0.35, 0.01, 2),
      restitution: between(options.restitution, base ? base.restitution : 0.1, 0, 1),
      wetSensitivity: between(options.wetSensitivity, base ? base.wetSensitivity : 0.4, 0, 1),
      elasticity: between(options.elasticity, base ? base.elasticity : 0.4, 0, 2),
      column: parts.column,
      beam: parts.beam,
      slab: parts.slab,
      brace: parts.brace
    });

    materials[id] = material;
    impactResistance[id] = Object.freeze(impacts);

    // Lets the UI add a dropdown option when materials are added at runtime too.
    if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('framelabs:material-added', {
        detail: { id: id, label: material.label }
      }));
    }

    return material;
  }

  function getMaterial(id) {
    return materials[id] || materials.concrete || null;
  }

  function getMaterialIds() {
    return Object.keys(materials);
  }

  // Built-in materials. Keep these ids stable because saved designs use them.
  addMaterial({
    id: 'steel',
    label: 'Steel',
    color: '#78caff',
    density: 7.8,
    staticFriction: 0.50,
    dynamicFriction: 0.30,
    restitution: 0.16,
    wetSensitivity: 0.78,
    elasticity: 0.78,
    column: { mass: 0.22, capacity: 28 },
    beam: { mass: 0.18, capacity: 18 },
    slab: { mass: 0.32, capacity: 15 },
    brace: { mass: 0.12, capacity: 13.5 },
    impactResistance: { column: 1.45, beam: 1.32, slab: 1.18, brace: 1.25 }
  });

  addMaterial({
    id: 'concrete',
    label: 'Concrete',
    color: '#b4c0d0',
    density: 2.35,
    staticFriction: 0.88,
    dynamicFriction: 0.64,
    restitution: 0.08,
    wetSensitivity: 0.28,
    elasticity: 0.25,
    column: { mass: 0.42, capacity: 17 },
    beam: { mass: 0.34, capacity: 11 },
    slab: { mass: 0.65, capacity: 8 },
    brace: { mass: 0.24, capacity: 7.2 },
    impactResistance: { column: 1.12, beam: 0.96, slab: 0.84, brace: 0.86 }
  });

  addMaterial({
    id: 'wood',
    label: 'Wood',
    color: '#dca76a',
    density: 0.68,
    staticFriction: 0.76,
    dynamicFriction: 0.49,
    restitution: 0.12,
    wetSensitivity: 0.62,
    elasticity: 0.58,
    column: { mass: 0.16, capacity: 9 },
    beam: { mass: 0.14, capacity: 6 },
    slab: { mass: 0.28, capacity: 3.8 },
    brace: { mass: 0.08, capacity: 4.1 },
    impactResistance: { column: 0.72, beam: 0.62, slab: 0.54, brace: 0.52 }
  });

  // Fictional reactive materials for in-game fire and chain-reaction effects.
  addMaterial({
    id: 'flammable',
    label: 'Flammable composite',
    color: '#f39a52',
    density: 0.86,
    staticFriction: 0.63,
    dynamicFriction: 0.41,
    restitution: 0.10,
    wetSensitivity: 0.48,
    elasticity: 0.44,
    column: { mass: 0.18, capacity: 7.6 },
    beam: { mass: 0.15, capacity: 5.4 },
    slab: { mass: 0.27, capacity: 3.1 },
    brace: { mass: 0.085, capacity: 3.7 },
    impactResistance: { column: 0.62, beam: 0.56, slab: 0.45, brace: 0.48 }
  });

  addMaterial({
    id: 'explosive',
    label: 'Explosive composite',
    color: '#ed6ca8',
    density: 1.12,
    staticFriction: 0.57,
    dynamicFriction: 0.37,
    restitution: 0.12,
    wetSensitivity: 0.42,
    elasticity: 0.38,
    column: { mass: 0.26, capacity: 8.8 },
    beam: { mass: 0.22, capacity: 6.4 },
    slab: { mass: 0.4, capacity: 4.6 },
    brace: { mass: 0.12, capacity: 4.8 },
    impactResistance: { column: 0.74, beam: 0.66, slab: 0.58, brace: 0.61 }
  });

  /*
   * BEGINNER EXAMPLE — copy this call and edit it to make another material.
   *
   * addMaterial({
   *   id: 'glass',
   *   label: 'Glass',
   *   basedOn: 'concrete',
   *   color: '#91e7ff',
   *   density: 2.5,
   *   staticFriction: 0.55,
   *   dynamicFriction: 0.32,
   *   restitution: 0.12,
   *   wetSensitivity: 0.35,
   *   elasticity: 0.3,
   *   column: { mass: 0.22, capacity: 8 },
   *   beam: { mass: 0.18, capacity: 5.5 },
   *   slab: { mass: 0.3, capacity: 4 },
   *   brace: { mass: 0.1, capacity: 3.5 },
   *   impactResistance: { column: 0.4, beam: 0.34, slab: 0.28, brace: 0.32 }
   * });
   *
   * Then choose "Glass" from the Material library dropdown in the game.
   * This API registers stats and colors; it does not add new fire behavior.
   */

  window.FrameLabMaterials = Object.freeze({
    materials: materials,
    impactResistance: impactResistance,
    componentKinds: COMPONENT_KINDS,
    addMaterial: addMaterial,
    getMaterial: getMaterial,
    getMaterialIds: getMaterialIds
  });
})();
