# tron-slope

A Slope-style rolling-ball runner rebuilt on a three.js (WebGL2) neon-dystopia renderer. No engine, no UI framework.

```bash
npm install
npm run dev
```

**Controls:** ← → / A D to steer · `` ` `` settings overlay (the game keeps running behind it) · after a crash: Space / ← → retries the same seed, R starts a new one, or type a seed into the summary.

**Seeds:** every run is seeded and shown bottom-left. `#seed=0000BEEF` in the URL replays a run; `&d=0.8` sets a difficulty floor (practice / debug).

```bash
npm run test:fairness -- 20 120   # autopilot plays 20 seeds × 120 s through the real physics
```

## Status

- **Phase 1: renderer, city, atmosphere, post stack, overlay.** Done.
- **Phase 2: SPEC.md.** Approved. Written from stills plus the owner's feature list; no footage, so its numbers are marked `[assumed]`.
- **Phase 3: gameplay from SPEC.md.** Done: seeded chunk generator, streaming with pooled meshes, fixed-timestep physics, a validator that rejects unwinnable chunks, seed display and replay, high scores.

### Implementation choices within the spec

- **Corridor margin.** The validator requires a surviving corridor ≥ **0.8 m** (0.4 m per side). That's above the spec's 0.6 m minimum, because 0.6 m at 200 km/h isn't humane.
- **Lateral speed.** The validator assumes only **50 %** of terminal lateral speed, to cover the ~0.15 s steering lag.
- **Course clock.** Moving hazards and rotating tunnels run on the generator's predicted arrival time at the ball's position, not wall time. Without this, real speed drifts ~0.3 s from the prediction over a 70 s run, and a gate validated as open could arrive closed.
- **Curves.** On curves the ball follows the deck heading and feels 20 % of the centrifugal pull. Fully world-straight motion made 35 m-radius curves need ~3× the available steering.
- **Fairness check.** `tools/fairness.mjs` runs a model-predictive autopilot that clones the real ball and searches input sequences through the actual physics. Over 40 seeds × 120 s (6.8 km, max difficulty), every seed survives with the deep search (`DEEP=1`).

## Layout

| Path | What |
| --- | --- |
| `src/gfx/glsl.js` | Shared GLSL: the single wind field (curl noise + gusts), fog, light pool, palette |
| `src/game/` | Seeded PRNG, course generator + validator + collision, pooled course rendering |
| `src/world/` | Ball physics, instanced city, sky/skyline, drones/billboards/cables, GPU particles, weather director |
| `src/ui/hud.js` | Seven-segment score, bests, death summary |
| `tools/fairness.mjs` | Headless autopilot fairness harness |
| `src/post/` | Post pipeline (~25 passes), LUTs, lens droplets |
| `src/settings/` | Schema-driven settings, presets, persistence |
| `src/ui/overlay.*` | Settings overlay, fps graph, per-effect cost readout |
| `docs/look-reference.webp` | Visual target (still image, not gameplay footage) |
