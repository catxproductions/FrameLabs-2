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

  // Unlike positiveOr, this accepts zero. For example, heatWeakening: 0
  // means the material does not gradually lose integrity from nearby heat.
  function nonNegativeOr(value, fallback) {
    const number = numberOr(value, fallback);
    return number >= 0 ? number : fallback;
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
   * Required: a unique id. Label and color are recommended for the UI.
   * Optional: isExplosive and isFlamable (true/false), basedOn, density,
   * friction/restitution/elasticity, heatWeakening/heatSensitivity, component stats,
   * and per-part impactResistance. Omitted settings inherit from basedOn
   * (concrete by default).
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
    const isExplosive = typeof options.isExplosive === 'boolean'
      ? options.isExplosive
      : Boolean(base && base.isExplosive);
    const isFlamable = typeof options.isFlamable === 'boolean'
      ? options.isFlamable
      : typeof options.isFlammable === 'boolean'
        ? options.isFlammable
        : Boolean(base && base.isFlamable);

    const material = Object.freeze({
      label: String(options.label || id),
      color: validColor(options.color, fallbackColor),

      // Gameplay switches are independent: neither, either, or both may be true.
      isExplosive: isExplosive,
      isFlamable: isFlamable,
      isFlammable: isFlamable, // Correct-spelling alias of isFlamable.

      // Contact and motion properties read by physics-model.js.
      density: positiveOr(options.density, base ? base.density : 1),
      staticFriction: between(options.staticFriction, base ? base.staticFriction : 0.6, 0.01, 2),
      dynamicFriction: between(options.dynamicFriction, base ? base.dynamicFriction : 0.35, 0.01, 2),
      restitution: between(options.restitution, base ? base.restitution : 0.1, 0, 1),
      wetSensitivity: between(options.wetSensitivity, base ? base.wetSensitivity : 0.4, 0, 1),
      elasticity: between(options.elasticity, base ? base.elasticity : 0.4, 0, 2),

      // Heat effects: change these per material instead of editing main.js.
      heatWeakening: nonNegativeOr(options.heatWeakening, base ? base.heatWeakening : 0.004),
      heatSensitivity: nonNegativeOr(options.heatSensitivity, base ? base.heatSensitivity : 1),

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

  /**
   * Register custom materials saved inside a FrameLabs BuildingMap JSON export.
   *
   * Existing built-ins are never overwritten. If a custom ID already exists,
   * its settings must match the file; otherwise the import stops with a readable
   * error instead of silently changing the material's physics.
   *
   * Returns the IDs of the newly registered materials.
   */
  function importMaterialLibrary(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('Material import needs a parsed design object.');
    }

    const incomingMaterials = payload.materialLibrary;
    if (
      !incomingMaterials ||
      typeof incomingMaterials !== 'object' ||
      Array.isArray(incomingMaterials)
    ) {
      return [];
    }

    const incomingImpact = payload.materialImpactResistance &&
      typeof payload.materialImpactResistance === 'object' &&
      !Array.isArray(payload.materialImpactResistance)
      ? payload.materialImpactResistance
      : {};

    const builtInIds = new Set([
      'steel',
      'concrete',
      'wood',
      'flammable',
      'explosive'
    ]);
    const pending = [];

    function sameDefinition(id, current, saved, savedImpact) {
      const textProperties = ['label', 'color'];
      const numberProperties = [
        'density',
        'staticFriction',
        'dynamicFriction',
        'restitution',
        'wetSensitivity',
        'elasticity',
        'heatWeakening',
        'heatSensitivity'
      ];

      for (const property of textProperties) {
        if (current[property] !== saved[property]) return false;
      }

      // Older exports may not contain newer optional properties.
      for (const property of numberProperties) {
        if (
          Object.prototype.hasOwnProperty.call(saved, property) &&
          Number(current[property]) !== Number(saved[property])
        ) {
          return false;
        }
      }

      const savedFlammable = typeof saved.isFlamable === 'boolean'
        ? saved.isFlamable
        : typeof saved.isFlammable === 'boolean'
          ? saved.isFlammable
          : false;

      if (
        current.isExplosive !== (saved.isExplosive === true) ||
        current.isFlamable !== savedFlammable
      ) {
        return false;
      }

      for (const kind of COMPONENT_KINDS) {
        if (
          Number(current[kind]?.mass) !== Number(saved[kind]?.mass) ||
          Number(current[kind]?.capacity) !== Number(saved[kind]?.capacity)
        ) {
          return false;
        }

        if (
          savedImpact &&
          Number(impactResistance[id]?.[kind]) !== Number(savedImpact[kind])
        ) {
          return false;
        }
      }

      return true;
    }

    // Validate and prepare every definition before changing the live library.
    for (const [id, saved] of Object.entries(incomingMaterials)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        throw new Error('The design contains an invalid custom material id: "' + id + '".');
      }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        throw new Error('The saved settings for material "' + id + '" are invalid.');
      }

      // Never let a saved file replace one of the known built-in definitions.
      if (materials[id]) {
        if (builtInIds.has(id)) continue;

        const savedImpact = incomingImpact[id] &&
          typeof incomingImpact[id] === 'object' &&
          !Array.isArray(incomingImpact[id])
          ? incomingImpact[id]
          : null;

        if (!sameDefinition(id, materials[id], saved, savedImpact)) {
          throw new Error(
            'Custom material "' + id + '" already exists with different settings. ' +
            'Use a unique id or make its entry in materials.js match the imported design.'
          );
        }
        continue;
      }

      if (pending.length >= 100) {
        throw new Error('This design contains too many custom materials (limit: 100).');
      }

      const options = {
        id: id,
        label: typeof saved.label === 'string' ? saved.label.slice(0, 100) : id,
        color: saved.color,
        basedOn: 'concrete',

        // Only real booleans are accepted. Missing flags default to false on import.
        isExplosive: typeof saved.isExplosive === 'boolean' ? saved.isExplosive : false,
        isFlamable: typeof saved.isFlamable === 'boolean'
          ? saved.isFlamable
          : typeof saved.isFlammable === 'boolean'
            ? saved.isFlammable
            : false,

        density: saved.density,
        staticFriction: saved.staticFriction,
        dynamicFriction: saved.dynamicFriction,
        restitution: saved.restitution,
        wetSensitivity: saved.wetSensitivity,
        elasticity: saved.elasticity,
        heatWeakening: saved.heatWeakening,
        heatSensitivity: saved.heatSensitivity,

        column: saved.column,
        beam: saved.beam,
        slab: saved.slab,
        brace: saved.brace,
        impactResistance: incomingImpact[id]
      };

      pending.push(options);
    }

    const registeredIds = [];
    for (const options of pending) {
      addMaterial(options);
      registeredIds.push(options.id);
    }

    return registeredIds;
  }

  // Ask for a behavior by capability, not by a built-in material id.
  // The second spelling is an alias to make the API forgiving of the common typo.
  function isFlammable(id) {
    const material = materials[id];
    return material?.isFlamable === true || material?.isFlammable === true;
  }

  function isExplosive(id) {
    return materials[id]?.isExplosive === true;
  }

  // Built-in materials. Keep these ids stable because saved designs use them.
  addMaterial({
    id: 'steel',
    label: 'Steel',
    isExplosive: false,
    isFlamable: false,
    heatWeakening: 0.0028,
    heatSensitivity: .78,
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
    isExplosive: false,
    isFlamable: false,
    heatWeakening: 0.0045,
    heatSensitivity: .88,
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
    isExplosive: false,
    isFlamable: false,
    heatWeakening: 0.009,
    heatSensitivity: 1.22,
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
    isExplosive: false,
    isFlamable: true,
    heatWeakening: 0.0065,
    heatSensitivity: 1,
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
    isExplosive: true,
    isFlamable: false,
    heatWeakening: 0.0055,
    heatSensitivity: 1,
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
   * BEGINNER EXAMPLE — copy this call, remove the leading comment markers, and edit it.
   * Keep it with the built-in addMaterial calls above the window.FrameLabMaterials export.
   *
   * addMaterial({
   *   id: 'glass',
   *   label: 'Glass',
   *   isExplosive: false,
   *   isFlamable: false,
   *   basedOn: 'concrete',
   *   color: '#91e7ff',
   *   density: 2.5,
   *   staticFriction: 0.55,
   *   dynamicFriction: 0.32,
   *   restitution: 0.12,
   *   wetSensitivity: 0.35,
   *   elasticity: 0.3,
   *   heatWeakening: 0.008,
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
    getMaterialIds: getMaterialIds,
    importMaterialLibrary: importMaterialLibrary,
    isFlammable: isFlammable,
    isExplosive: isExplosive
  });
})();
