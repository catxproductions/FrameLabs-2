# FrameLab — original structural sandbox with adaptive physics and compute helpers

This package is based on the supplied original FrameLab project. It preserves the original building examples, structural solver, layout, materials, failure flow, and canvas renderer while adding a reduced-order contact/environment model and a few optional interaction/rendering systems.

## Run

Serve the folder over HTTP/HTTPS (for example, GitHub Pages or `python -m http.server`), then open `index.html`. Do not launch with `file://` when testing workers or WebGPU. GPU availability depends on browser, OS, driver, device and secure-context support.

## New behavior

- **120 Hz fixed substeps** use a capped accumulator, bounded catch-up work, swept debris/member contact checks, and quality-dependent iterative member constraints. On very slow frames, excess wall-clock time is intentionally discarded to avoid a spiral of death; physics cannot guarantee perfect real-time catch-up on a heavily overloaded device.
- **Material-pair friction and restitution** vary smoothly with relative contact speed and the surface-moisture setting, with different material parameters for steel, concrete, wood, flammable composite and explosive composite.
- **Impact deformation** combines a temporary elastic component (which recovers over time) with a persistent plastic component. This is a simplified member-level deformation model, not a full deformable-mesh or mass-spring soft-body solver.
- **Environmental forces** add area/mass-scaled quadratic drag and density-dependent buoyancy to loose debris, plus a reduced buoyancy/drag response on structural nodes when water is enabled. Parameters use normalized game units and are illustrative, not SI-calibrated.
- **Gravity Tether (`T`)** lets the user click-drag a nearby joint or debris member with a damped, force-capped spring; detached members can swing, rotate, collide and settle when released.
- **Adaptive quality** performs a brief synthetic CPU constraint benchmark and, where available, a supplemental WebGPU demand/capacity-scan benchmark. Entry/Balanced/Enthusiast presets tune constraint iterations, debris caps, render pixel ratio, contact-shadow approximation, and atmospheric/wet highlights. Manual presets remain selected instead of being overwritten by the automatic result.
- **Moisture and water sliders** influence contact response and provide lightweight Canvas2D material/water visual cues.
- **Hide UI (`H`)** expands the simulation canvas; **Icons: On/Off (`O`)** hides annotation clutter such as grid lines, node dots, labels, load arrows, contact/failure markers, hover hints and status banners. Both floating controls stay available.

## CPU worker and WebGPU diagnostic

- `js/compute-worker.js` scans snapshots of active member demand/capacity values off the main thread.
- `js/compute-backends.js` resolves the worker URL relative to its own script, including under a GitHub Pages subpath.
- WebGPU is used opportunistically for a large numerical scan (2,048+ members). It is not running the authoritative structural simulation on the GPU. If WebGPU setup/dispatch/device access fails, the diagnostic falls back to the CPU worker and then to a main-thread scan if necessary.
- The benchmark measures time for a GPU compute-and-readback scan, so it includes browser/API overhead and should be treated as a practical capability probe, not a hardware peak-throughput specification.

## Rendering and modeling limits

FrameLab is a 2D Canvas simulation. Contact shadows, wet highlights, haze and water appearance are Canvas2D approximations; this is not a true 3D screen-space contact-shadow or volumetric-lighting pipeline. The structural engine still owns gravity, load propagation, connectivity, failure, collision response and the main simulation state on the CPU. The new material/environment model and visual deformation improve feedback but are not a validated engineering or finite-element solver. Do not use the simulation for real structural design or safety decisions.

## Checks

Run:

```sh
npm run check
```

The tests check example JSON integrity, asset and worker URLs, CPU-worker math/fallback behavior, GPU-unavailable handling, fixed-step/UI wiring, nonlinear contact response, submersion/buoyancy, quality selection, and moisture shading. These automated tests do not replace an interactive browser/hardware test of the complete game.
