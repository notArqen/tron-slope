# tron-slope

A Slope-style rolling-ball runner rebuilt on a three.js (WebGL2) neon-dystopia renderer. No engine, no UI framework.

```bash
npm install
npm run dev
```

**Controls:** ← → / A D to steer · `` ` `` opens the settings overlay (the game keeps running behind it).

## Status

- **Phase 1: renderer, city, atmosphere, post stack, overlay.** Done.
- **Phase 2: SPEC.md from reference footage.** Blocked until gameplay footage is in `reference/`.
- **Phase 3: gameplay from the approved spec.** Not started.

The track is a placeholder: a straight slope with generic test blocks used for readability testing. None of it is Slope's level design.

## Layout

| Path | What |
| --- | --- |
| `src/gfx/glsl.js` | Shared GLSL: the single wind field (curl noise + gusts), fog, light pool, palette |
| `src/world/` | Track, ball, instanced city, sky/skyline, drones/billboards/cables, GPU particles, weather director |
| `src/post/` | Post pipeline (~25 passes), LUTs, lens droplets |
| `src/settings/` | Schema-driven settings, presets, persistence |
| `src/ui/overlay.*` | Settings overlay, fps graph, per-effect cost readout |
| `docs/look-reference.webp` | Visual target (still image, not gameplay footage) |
