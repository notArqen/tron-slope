# tron-slope: gameplay spec (DRAFT, awaiting approval)

> **Provenance.** The only reference is one still image: `reference/stills/google-slope-results.webp`, a Google Images grid of ~30 Slope thumbnails, several of them other games (Slope Tunnel, Slope Rider, Slope 3). There is **no video**, so the ffmpeg contact-sheet step could not run, and nothing about speed, timing or spacing can be measured. Items marked **[observed]** are visible in the original-Slope thumbnails of that still. Everything else is **[assumed]**, either from the owner's feature list (moving obstacles, tunnels, jumps between platforms, thin curved platforms, high score) or picked to fit the current renderer (ball r = 0.55 m, base slope 11°). Add gameplay video to `reference/` and the numbers get re-derived from it.

## 0. What the stills show [observed]

- **Palette:** pure black background. Every surface is drawn as bright green grid lines (wireframe look), and hazards are **red** grid boxes.
- **Ball:** green wireframe sphere with longitude/latitude seams over a dark body, sitting in the lower-centre of the frame.
- **Camera:** behind and slightly above the ball, looking down the slope toward a central vanishing point. The track fills the lower half of the frame.
- **Track:** green grid deck with brighter edges. Several thumbnails show **separate platform pieces** with void between them, and some show the path **curving / tilting** off to one side.
- **Hazards:** red boxes **on the deck** and red block columns **flanking** the track like walls.
- **Surroundings:** tall green grid tower walls on both sides in several thumbnails. Some have no surroundings at all, just a void.
- **HUD:** one large integer score at **top centre**, in a blocky green pixel/segment style.
- **Not observed in original-Slope thumbnails:** tunnels. The hex tunnels in the grid belong to *Slope Tunnel*, a different game, so §3's tunnel spec is owner-requested, not observed.

Units: metres, seconds. "Forward" is downhill (−z).

---

## 1. Speed and acceleration [assumed]

| Parameter | Value |
| --- | --- |
| Start speed | 14 m/s (~50 km/h) |
| Max speed | 62 m/s (~220 km/h) |
| Curve | `v += k·(1 − v/vmax)·dt`, with k = 4.8 m/s². ~50% of the remaining headroom is gone after 25 s and ~90% after 80 s |
| Steeper sections | +2.5 m/s² while the local slope exceeds the base slope; flats and uphill kickers cost speed (−3 m/s²) |
| Floor | Speed never drops below 14 m/s, so the run never stalls |

Speed is not player-controlled. The only input is steering.

## 2. Steering feel [assumed]

- Input: ← → / A D (digital), mapped to a lateral target in [−1, 1].
- Lateral acceleration is 46 m/s², with exponential damping (τ ≈ 0.15 s), so a tap gives a short nudge and a hold reaches ~7 m/s lateral within 0.3 s.
- Steering works **only while grounded**. In the air the ball keeps its lateral velocity (air control 0%), so jumps are committed at take-off.
- On a tilted (banked) section, gravity adds lateral pull `g·sin(bank)` toward the low side.
- The camera follows lateral movement at 60% and rolls with the bank (max 12°).

## 3. Track segment types [assumed]

Each segment is a chunk 30–90 m long. Widths are full surface widths.

| Type | Width | Notes |
| --- | --- | --- |
| **Straight** | 7 m | Baseline. Grid deck with neon rails. |
| **Narrow straight** | 3.5–5 m | Width eases over 8 m at each end. |
| **Thin curved platform** | 1.6–2.5 m | Path bends laterally, S-curves allowed. Peak lateral offset ±6 m, minimum radius 35 m. No rails. |
| **Banked (tilted) section** | 7 m | Rolls ±8–22° about the forward axis; the bank ramps in and out over 10 m. |
| **Steep drop** | 7 m | Slope 11° → 25° for 15–30 m, then back. Speed boost. |
| **Gap / jump** | n/a | A ramp lip (4 m, +6° kick) ends one platform; the next starts lower and further on (§5). |
| **Split** | 2 × 2.5 m | Two parallel lanes with a void between, merging back after 20–40 m. |
| **Tunnel** | 7 m | An enclosing tube (square or hex section, 5 m clearance) over a normal deck. Ceiling and walls are solid, and wall contact kills. Interior lit by grid lines. 40–120 m long. |
| **Rotating tunnel** | 7 m | Tunnel whose section rolls slowly (≤ 25°/s), dragging the ball sideways like a bank. Unlocks late. |

## 4. Obstacles [assumed]

All obstacles keep the Phase 1 readability rule: emissive red edges plus a minimum-contrast rim, readable through any weather inside the reaction distance.

| Obstacle | Shape | Motion |
| --- | --- | --- |
| **Block** | 0.8–2.6 m wide, 1–2.5 m tall box | Static |
| **Wall with gap** | Spans the deck, with a 1.6–2.5 m opening | Static |
| **Slider** | 1.2–2 m box | Moves laterally, sinusoidal, amplitude up to (width − box)/2, period 1.6–3.5 s |
| **Gate / crusher** | Bar across the deck | Rises and falls vertically; open ≥ 45% of its period |
| **Pendulum** | Block on an arm | Swings across the deck, period 2–4 s |
| **Rotor** | Two crossed bars at deck centre | Spins about the vertical axis, 40–90°/s |
| **Tunnel fins** | Plates from a wall or ceiling | Static or slowly rotating with the tunnel |

Spacing is measured in **seconds of travel**, not metres, so it scales with speed:

- Minimum time between consecutive obstacle "decisions": 0.9 s at difficulty 0, down to 0.45 s at difficulty 1.
- No obstacle within 1.2 s of travel after a landing.
- No obstacle within 0.6 s of travel before a ramp lip.

## 5. Jumps [assumed]

- Take-off: the ball leaves the lip with its velocity at that moment (kick +6°).
- Landing platform: placed **lower** than the lip, at 2–10 m of drop.
- Gap length is generated from **ballistic reach** at the speed the generator predicts for that point:
  `reach = v·cosθ · (v·sinθ + sqrt((v·sinθ)² + 2·g·drop)) / g`, with g = 28 m/s² (gameplay gravity).
- Gap length = 0.45–0.8 × reach. The landing zone is at least 12 m deep and at least as wide as the take-off platform at difficulty 0, narrowing to 2.5 m at difficulty 1.
- The landing platform's lateral offset must lie within the lateral reach `v_lat_max · airtime` reduced by 30% (lateral speed is frozen in the air, so the player has to line up before the lip).

## 6. Difficulty ramp [assumed]

Difficulty `d ∈ [0, 1]` = `min(1, distance / 3000 m)`, eased by `smoothstep`.

| d | Unlocks / changes |
| --- | --- |
| 0.0 | Straights, narrow straights, static blocks |
| 0.1 | Banked sections, steep drops, walls with gaps |
| 0.2 | Gaps / jumps (generous reach factor 0.45) |
| 0.3 | Tunnels, sliders |
| 0.45 | Thin curved platforms, splits, gates |
| 0.6 | Pendulums, rotors, moving obstacles inside tunnels |
| 0.75 | Rotating tunnels, reach factor up to 0.8, thin platforms down to 1.6 m |
| 1.0 | Minimum decision spacing 0.45 s, combos (e.g. a jump landing onto a thin curve) |

Segment choice is weighted random among the unlocked types. No type appears more than twice in a row, and a "breather" straight (≥ 1.5 s, no obstacles) follows every 4–6 segments.

## 7. Procedural generation and fairness [assumed]

- **Seeded:** a 32-bit seed drives a single PRNG (mulberry32). Same seed means the same run. The seed is shown on screen and can be typed in to replay.
- **Chunks:** the generator emits chunks ~200 m ahead and despawns them ~40 m behind. Meshes, colliders and obstacles come from object pools.
- **Predicted speed:** the generator integrates the §1 speed curve along the planned path, so gaps and spacing use the speed the player will actually have.
- **Validator** (runs per chunk before it is accepted):
  1. **Reachability:** sweep a set of player "ghosts" (lateral positions sampled every 0.25 m) through the chunk using the real physics at the predicted speed, with inputs limited to what is reachable given steering acceleration. Moving obstacles are evaluated against their deterministic phase at the predicted arrival time ± 0.15 s.
  2. The chunk passes only if **≥ 1 ghost survives with ≥ 0.6 m lateral margin** on every thin platform and every obstacle opening.
  3. It must also connect: a surviving ghost's exit position must be a valid entry for the next chunk.
  4. On failure the generator rerolls with the next PRNG draw, up to 8 times, then falls back to a breather straight. Rejections are counted in the debug overlay.
- **No blind hazards:** every hazard must be visible (not occluded by tunnel geometry) for ≥ the reaction time (Debug → reaction time, default 1.0 s) before contact.

## 8. Scoring

- Score = distance travelled / 4, shown as one integer at top centre. **[observed]** placement; **[assumed]** formula. The HUD digits switch to the green blocky style from the stills in Phase 3.
- **High score** (owner request). Already implemented ahead of Phase 3:
  - Best score persists in localStorage and shows as `BEST n` under the score.
  - When a run passes the old best, the live score turns green. On death, `NEW BEST n` replaces `CRASHED`.
  - Runs in Debug → No death never count.
  - Phase 3 adds a per-seed best next to the overall best. [assumed]
- No combo multipliers or pickups. [assumed: kept minimal unless footage shows otherwise]

## 9. Death and restart [assumed]

- **Deaths:** hitting an obstacle face (side contact over 0.25 m/s laterally, or any frontal contact), touching a tunnel wall or ceiling, or falling more than 9 m below the expected track height.
- On death: the glitch burst (Phase 1 default), camera shake, and the ball shatters into grid shards. Simulation time slows to 25% for 0.4 s.
- After **1.2 s** a summary shows score, best (overall + this seed) and seed. Any steer key or Space restarts **the same seed**; R starts a **new random seed**.
- On restart, chunks are regenerated from the seed, so there is no stale state from the pools.

## 10. Out of scope for Phase 3

Audio, menus beyond the death summary, leaderboards, cosmetics.

---

## Amendments (owner requests after approval, 2026-10-20)

- **A1 Winding sections.** Long sweeping S-bends, 120–220 m long, amplitude ≤ 9 m (min radius 25 m), width 3–5 m. They also roll up and down, with crests placed on the bend inflections so hops only happen where the track runs straight. Unlocks at d = 0.25. [assumed]
- **A2 Crest airtime.** The ball leaves the deck wherever the deck drops away faster than gravity can follow (`v²·Δslope/Δs > g`). No steering in the air. The generator predicts the same flights, so the validator treats them as no-steer steps.
- **A3 Thin platforms widened.** 2.2–3.2 m instead of 1.6–2.5 m (owner: "too hard").
- **A4 Tunnels** are octagonal in section. Floating wireframe cubes drift beside the track (visual only).
- **A5 Curves.** The ball follows the deck heading and feels 10% of the centrifugal pull. Curvature is clamped at 1/25 m.
- **A6 Modes.** Title screen, pause menu, Autoplay (model-predictive autopilot; runs never count toward bests), and a light-cycle vehicle that is visual only, with the same physics and collision sphere as the ball.
