# FrameLabs 2 material guide

Materials are defined in `js/materials.js`. The physics formulas live separately in
`js/physics-model.js`, and the simulation uses the shared material library.

## Add a material

Open `js/materials.js`. Copy the example below the comment **BEGINNER EXAMPLE**
and place your own `addMaterial({...})` call alongside the built-in materials,
before the final `window.FrameLabMaterials = Object.freeze(...)` export.

```js
addMaterial({
  // Every material needs a unique id made of lowercase letters, numbers, "_" or "-".
  id: 'glass',
  label: 'Glass',
  color: '#91e7ff',

  // Use another material as the starting point for settings you leave out.
  basedOn: 'concrete',

  // Behavior switches. Use actual true / false values.
  isExplosive: false,
  isFlamable: false,

  // Contact and motion properties (illustrative game units).
  density: 2.5,
  staticFriction: 0.55,
  dynamicFriction: 0.32,
  restitution: 0.12,
  wetSensitivity: 0.35,
  elasticity: 0.3,

  // How quickly heat damages the material, and its sensitivity to that damage.
  heatWeakening: 0.008,
  heatSensitivity: 1,

  // Each component type has its own mass and strength.
  column: { mass: 0.22, capacity: 8 },
  beam:   { mass: 0.18, capacity: 5.5 },
  slab:   { mass: 0.30, capacity: 4 },
  brace:  { mass: 0.10, capacity: 3.5 },

  // Resistance to impacts for each component type.
  impactResistance: {
    column: 0.4,
    beam: 0.34,
    slab: 0.28,
    brace: 0.32
  }
});
```

After adding a material, its label is added to the game's **Material library** dropdown
automatically. You do not need to edit `main.js` to register its basic properties.

## What the two switches mean

- `isExplosive: true` allows blasts, strong impacts, and heat to trigger the material's
  existing virtual chain-reaction behavior.
- `isFlamable: true` allows the material to ignite, burn, and spread fire to connected
  combustible members. The requested spelling `isFlamable` is supported; the library
  also accepts `isFlammable` as an alternative spelling.
- Both can be true. Igniting a material with both switches on starts a fire; sustained
  burning can prime its explosive behavior. Set both to false for a material with neither
  behavior.

These properties can be edited independently, so creating a new material does not require
copying or changing the fire and explosion functions in `main.js`.

## Notes

- Keep each `id` unique. Saved designs identify materials by this id, so do not rename
  an id after sharing saved designs that use it.
- `basedOn` copies unspecified defaults from that material; explicitly supplied settings
  override the inherited settings.
- `heatWeakening: 0` disables gradual integrity loss from heat. Other heat-related behavior
  may still apply if a fire or explosive switch is enabled.
- All masses, capacities, and physical responses are simplified game values, not engineering
  measurements or real-world structural design data.
