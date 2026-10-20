// Every user-facing knob lives here: key, label, one-line tip, section, type,
// default, range. The overlay is generated from this table; presets override a
// subset. `alsoIn` renders the same control in a second section.

export const SECTIONS = ['Performance', 'Quality', 'Light', 'Surfaces', 'Atmosphere', 'Weather', 'Lens', 'Motion', 'Color', 'Style', 'Debug'];

const R = (key, label, tip, section, def, min, max, step, extra = {}) => ({ key, label, tip, section, type: 'range', def, min, max, step, ...extra });
const B = (key, label, tip, section, def, extra = {}) => ({ key, label, tip, section, type: 'bool', def, ...extra });
const S = (key, label, tip, section, def, options, extra = {}) => ({ key, label, tip, section, type: 'select', def, options, ...extra });

export const SCHEMA = [
  // ---------------------------------------------------------------- Performance
  S('preset', 'Preset', 'Applies a full quality tier; any manual change flips this to Custom.', 'Performance', 'high',
    [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']]),
  B('dynRes', 'Dynamic resolution', 'Scales internal resolution up/down to hold the target fps.', 'Performance', true),
  R('targetFps', 'Target fps', 'Frame rate dynamic resolution tries to hold.', 'Performance', 60, 30, 144, 1),
  R('renderScale', 'Render scale', 'Internal resolution as a fraction of the display (before dynamic scaling).', 'Performance', 1, 0.4, 1, 0.05),
  R('maxDpr', 'Max pixel ratio', 'Caps device pixel ratio; 2 = full Retina, 1 = half the pixels.', 'Performance', 1.5, 1, 2, 0.25),
  S('fpsCap', 'FPS cap', 'Hard frame-rate limit (Off = display refresh).', 'Performance', 'off', [['off', 'Off'], ['30', '30'], ['60', '60'], ['120', '120']]),
  S('shadowQuality', 'Shadow quality', 'Ball shadow: blob, or analytic soft shadows from pooled lights.', 'Performance', 'soft',
    [['off', 'Off'], ['blob', 'Blob'], ['soft', 'Soft (4 lights)'], ['ultra', 'Soft (all lights)']]),
  S('reflectionQuality', 'Reflection quality', 'Wet-track reflections: planar fallback or screen-space ray march.', 'Performance', 'ssr-low',
    [['off', 'Off'], ['planar', 'Planar (fallback)'], ['ssr-low', 'SSR low'], ['ssr-high', 'SSR high']]),
  R('particleCount', 'Particle count', 'Multiplier on every pooled particle system.', 'Performance', 1, 0, 2, 0.05),

  // ---------------------------------------------------------------- Quality
  S('aa', 'Anti-aliasing', 'FXAA is cheapest, SMAA sharpest, TAA most stable (jittered history).', 'Quality', 'taa',
    [['none', 'None'], ['fxaa', 'FXAA'], ['smaa', 'SMAA'], ['taa', 'TAA']]),
  B('cas', 'CAS sharpening', 'Contrast-adaptive sharpening on the final image.', 'Quality', true),
  R('casStrength', 'CAS strength', 'How hard CAS sharpens.', 'Quality', 0.4, 0, 1, 0.05),
  R('fogSteps', 'Fog ray steps', 'Volumetric fog samples per pixel (half-res).', 'Quality', 16, 4, 32, 1),
  R('aoSamples', 'AO samples', 'Horizon samples for ambient occlusion.', 'Quality', 8, 4, 16, 1),
  R('ssrSteps', 'SSR steps', 'Ray-march steps for screen-space reflections.', 'Quality', 32, 8, 64, 1),
  R('dofSamples', 'DOF samples', 'Bokeh disc taps for depth of field.', 'Quality', 24, 8, 48, 1),
  R('mbSamples', 'Motion blur samples', 'Taps along the velocity vector.', 'Quality', 8, 4, 16, 1),
  R('bloomMips', 'Bloom mips', 'Depth of the bloom pyramid; more = wider glow.', 'Quality', 6, 3, 7, 1),
  R('lightPool', 'Light pool size', 'Cheap dynamic lights for neon spill (nearest N fixtures).', 'Quality', 12, 0, 16, 1),
  R('cityDensity', 'City density', 'Fraction of the instanced tower pool drawn.', 'Quality', 1, 0.3, 1, 0.05),
  B('halfResEffects', 'Half-res AO/SSR', 'Run AO and SSR at half resolution.', 'Quality', true),

  // ---------------------------------------------------------------- Light
  B('bloom', 'Bloom', 'Selective HDR bloom driven by the emissive mask.', 'Light', true),
  R('bloomStrength', 'Bloom strength', 'Amount of glow added back.', 'Light', 0.9, 0, 3, 0.05),
  R('bloomThreshold', 'Bloom threshold', 'Luminance where non-emissive pixels start to glow.', 'Light', 1.4, 0, 5, 0.05),
  R('bloomRadius', 'Bloom radius', 'Blend weight of the wider mips.', 'Light', 0.75, 0, 1, 0.05),
  R('bloomSelective', 'Emissive weight', 'How much the emissive mask forces glow regardless of threshold.', 'Light', 0.6, 0, 2, 0.05),
  B('streaks', 'Anamorphic streaks', 'Horizontal lens streaks on highlights.', 'Light', true),
  R('streakStrength', 'Streak strength', 'Intensity of the anamorphic streaks.', 'Light', 0.35, 0, 2, 0.05),
  R('streakLength', 'Streak length', 'How far streaks stretch.', 'Light', 0.7, 0.1, 1, 0.05),
  B('flare', 'Lens flare + ghosts', 'Mirrored ghost images and halo from bright sources.', 'Light', true),
  R('flareStrength', 'Flare strength', 'Intensity of ghosts and halo.', 'Light', 0.25, 0, 2, 0.05),
  R('flareGhosts', 'Ghost count', 'Number of ghost images.', 'Light', 4, 1, 8, 1),
  B('halation', 'Halation', 'Warm red film-style bleed around highlights.', 'Light', true),
  R('halationStrength', 'Halation strength', 'Amount of red bleed.', 'Light', 0.3, 0, 2, 0.05),
  B('dirt', 'Bloom dirt mask', 'Procedural lens grime revealed by bright glow.', 'Light', true),
  R('dirtStrength', 'Dirt strength', 'How much grime the glow reveals.', 'Light', 0.6, 0, 2, 0.05),

  // ---------------------------------------------------------------- Surfaces
  B('reflections', 'Reflections', 'Wet surface reflections (mode set in Performance).', 'Surfaces', true),
  R('reflStrength', 'Reflection strength', 'Multiplier on reflected light.', 'Surfaces', 1, 0, 2, 0.05),
  B('ao', 'Ambient occlusion', 'GTAO-style horizon occlusion from depth.', 'Surfaces', true),
  R('aoRadius', 'AO radius', 'World-space occlusion radius.', 'Surfaces', 1.6, 0.2, 5, 0.1),
  R('aoIntensity', 'AO intensity', 'Darkening strength.', 'Surfaces', 1.0, 0, 3, 0.05),
  B('gi', 'Screen-space GI', 'Cheap one-bounce colour bleed from nearby emissives.', 'Surfaces', true),
  R('giStrength', 'GI strength', 'Amount of bounced neon.', 'Surfaces', 0.5, 0, 2, 0.05),
  B('puddles', 'Puddles', 'Puddles with animated rain-ripple normals.', 'Surfaces', true),
  R('puddleCoverage', 'Puddle coverage', 'How much of the track pools water (scaled by wetness).', 'Surfaces', 0.5, 0, 1, 0.05),
  B('grime', 'Grime + cracks', 'Grime streaks and cracks on road and glass shaders.', 'Surfaces', true),

  // ---------------------------------------------------------------- Atmosphere
  B('fog', 'Height fog', 'Layered height fog + ground-hugging mist.', 'Atmosphere', true),
  R('fogDensityMul', 'Fog density', 'Multiplier on the weather-driven fog density.', 'Atmosphere', 1, 0, 3, 0.05),
  B('volumetric', 'Volumetric light', 'Half-res ray-marched fog with searchlight shafts.', 'Atmosphere', true),
  R('volStrength', 'Shaft strength', 'Brightness of volumetric light shafts.', 'Atmosphere', 1, 0, 3, 0.05),
  B('godrays', 'God rays', 'Screen-space radial rays from the sky glow / lightning.', 'Atmosphere', true),
  R('godrayStrength', 'God ray strength', 'Intensity of the radial rays.', 'Atmosphere', 0.5, 0, 2, 0.05),
  B('haze', 'Depth haze tint', 'Distance-based tint toward the smog colour.', 'Atmosphere', true),
  R('hazeStrength', 'Haze strength', 'How strongly distance shifts toward smog.', 'Atmosphere', 0.5, 0, 1, 0.05),
  R('mistHeight', 'Mist height', 'Thickness of the ground-hugging mist layer (m).', 'Atmosphere', 9, 1, 30, 0.5),
  B('steam', 'Steam vents', 'Steam rising from street grates.', 'Atmosphere', true, { alsoIn: 'Weather' }),

  // ---------------------------------------------------------------- Weather
  S('weatherState', 'Weather state', 'Manual target state (auto-cycle overrides).', 'Weather', 'drizzle',
    [['clear', 'Clear haze'], ['drizzle', 'Drizzle'], ['storm', 'Storm'], ['dust', 'Dust storm'], ['ash', 'Ash fall'], ['blackout', 'Blackout']]),
  B('weatherAuto', 'Auto-cycle', 'Cycle weather on a timer, intensifying with run time and speed.', 'Weather', true),
  R('weatherCycle', 'Cycle period (s)', 'Seconds each state is held before blending to the next.', 'Weather', 35, 10, 180, 1),
  R('weatherIntensity', 'Intensity', 'Global multiplier on every weather parameter.', 'Weather', 1, 0, 2, 0.05),
  R('windStrength', 'Wind strength', 'Multiplier on the shared wind field.', 'Weather', 1, 0, 3, 0.05),
  R('windDir', 'Wind direction', 'Heading of the base wind in degrees.', 'Weather', 25, 0, 360, 1),
  R('gustiness', 'Gustiness', 'How often and how hard gust events fire.', 'Weather', 0.6, 0, 1, 0.05),
  B('rain', 'Rain', 'Instanced wind-angled rain streaks.', 'Weather', true, { alsoIn: 'Atmosphere' }),
  R('rainDensity', 'Rain density', 'Rain streak count multiplier.', 'Weather', 1, 0, 2, 0.05),
  B('splashes', 'Splashes', 'Splash particles when the ball crosses puddles.', 'Weather', true),
  B('lensDroplets', 'Lens droplets', 'Refractive screen droplets that blow, streak and clear with speed.', 'Weather', true, { alsoIn: 'Lens' }),
  R('dropletDensity', 'Droplet density', 'Size of the droplet pool in use.', 'Weather', 1, 0, 2, 0.05),
  B('dustMotes', 'Dust motes', 'Motes visible only inside light shafts.', 'Weather', true),
  R('dustDensity', 'Dust density', 'Mote / dust-storm particle multiplier.', 'Weather', 1, 0, 2, 0.05),
  B('ash', 'Ash', 'Falling ash flakes.', 'Weather', true),
  R('ashDensity', 'Ash density', 'Ash count multiplier.', 'Weather', 1, 0, 2, 0.05),
  B('debris', 'Debris', 'Paper and trash tumbling in gusts.', 'Weather', true),
  R('debrisDensity', 'Debris density', 'Debris count multiplier.', 'Weather', 1, 0, 2, 0.05),
  B('embers', 'Embers + sparks', 'Sparks raining from broken fixtures.', 'Weather', true),
  R('emberDensity', 'Ember density', 'Spark count multiplier.', 'Weather', 1, 0, 2, 0.05),
  B('ballDust', 'Ball dust', 'Dust and spray kicked up behind the ball.', 'Weather', true),
  B('cables', 'Hanging cables', 'Catenary cables swaying in the wind.', 'Weather', true),
  B('drones', 'Drones', 'Patrol drones with volumetric searchlights.', 'Weather', true),
  B('billboards', 'Holo-billboards', 'Glitching abstract-glyph billboards.', 'Weather', true),
  B('strobes', 'Distant strobes', 'Red/blue strobes on far towers.', 'Weather', true),
  B('lightning', 'Lightning', 'Distant lightning silhouetting the skyline.', 'Weather', true),
  B('neonFlicker', 'Neon flicker', 'Flickering/buzzing neon with dead grid sections.', 'Weather', true),
  B('surges', 'Power surges', 'Pulses travelling along emissive grid lines.', 'Weather', true),

  // ---------------------------------------------------------------- Lens
  B('dof', 'Depth of field', 'Bokeh DOF focused on the ball.', 'Lens', true),
  R('dofAperture', 'Aperture', 'Blur amount away from the focus plane.', 'Lens', 0.5, 0, 2, 0.05),
  R('dofMaxBlur', 'Max bokeh size', 'Largest bokeh radius in pixels (at 1080p).', 'Lens', 10, 2, 24, 1),
  B('ca', 'Chromatic aberration', 'Radial RGB split toward the edges.', 'Lens', true),
  R('caStrength', 'CA strength', 'Size of the colour split.', 'Lens', 0.35, 0, 2, 0.05),
  B('distortion', 'Lens distortion', 'Barrel distortion.', 'Lens', true),
  R('distortionAmt', 'Distortion amount', 'Positive = barrel, negative = pincushion.', 'Lens', 0.06, -0.3, 0.3, 0.01),
  B('vignette', 'Vignette', 'Darkened corners.', 'Lens', true),
  R('vignetteStrength', 'Vignette strength', 'Corner darkening.', 'Lens', 0.45, 0, 1.5, 0.05),
  B('grain', 'Film grain', 'Luminance-aware animated grain.', 'Lens', true),
  R('grainStrength', 'Grain strength', 'Grain amplitude.', 'Lens', 0.05, 0, 0.3, 0.005),

  // ---------------------------------------------------------------- Motion
  B('motionBlur', 'Motion blur', 'Per-pixel camera motion blur scaled by speed.', 'Motion', true),
  R('mbStrength', 'Motion blur strength', 'Shutter fraction.', 'Motion', 0.6, 0, 2, 0.05),
  B('radialBlur', 'Radial speed blur', 'Zoom blur toward the vanishing point at speed.', 'Motion', true),
  R('radialStrength', 'Radial strength', 'Zoom blur amount at top speed.', 'Motion', 0.5, 0, 2, 0.05),
  B('fovKick', 'FOV kick', 'Field of view widens with speed.', 'Motion', true),
  R('fovKickAmt', 'FOV kick amount', 'Extra degrees of FOV at top speed.', 'Motion', 14, 0, 30, 1),
  B('shake', 'Camera shake', 'Speed, lightning and impact shake.', 'Motion', true),
  R('shakeAmt', 'Shake amount', 'Shake amplitude.', 'Motion', 0.5, 0, 2, 0.05),
  B('heatHaze', 'Heat haze', 'Shimmer over vents and near the hot track.', 'Motion', true),
  R('heatHazeStrength', 'Heat haze strength', 'Shimmer distortion amount.', 'Motion', 0.5, 0, 2, 0.05),

  // ---------------------------------------------------------------- Color
  S('neonPalette', 'Neon palette', 'Colour of the grid, ball seams and hazards.', 'Color', 'slope',
    [['slope', 'Slope green'], ['tron', 'Tron cyan'], ['legacy', 'Legacy amber'], ['ares', 'Ares red']]),
  S('tonemapper', 'Tonemapper', 'HDR to display curve.', 'Color', 'agx', [['aces', 'ACES'], ['agx', 'AgX'], ['filmic', 'Filmic'], ['reinhard', 'Reinhard']]),
  R('exposure', 'Exposure', 'Manual exposure (EV offset when auto-exposure is on).', 'Color', 0, -3, 3, 0.05),
  B('autoExposure', 'Auto-exposure', 'Eye adaptation from average scene luminance.', 'Color', true),
  R('aeSpeed', 'Adaptation speed', 'How fast exposure adapts.', 'Color', 1.5, 0.1, 5, 0.1),
  S('lut', 'LUT grade', 'Colour-grade lookup preset.', 'Color', 'tron', [['tron', 'Classic Tron blue'], ['legacy', 'Legacy orange'], ['ares', 'Ares red'], ['neutral', 'Neutral']]),
  R('lutStrength', 'LUT strength', 'Blend between ungraded and graded.', 'Color', 0.7, 0, 1, 0.05),
  R('saturation', 'Saturation', 'Post-tonemap saturation.', 'Color', 1.1, 0, 2, 0.05),
  R('contrast', 'Contrast', 'Post-tonemap contrast around mid grey.', 'Color', 1.08, 0.5, 1.5, 0.01),
  R('lift', 'Lift', 'Shadow offset.', 'Color', 0, -0.2, 0.2, 0.005),
  R('gamma', 'Gamma', 'Midtone power.', 'Color', 1, 0.5, 2, 0.01),
  R('gain', 'Gain', 'Highlight multiplier.', 'Color', 1, 0.5, 2, 0.01),

  // ---------------------------------------------------------------- Style
  B('scanlines', 'Scanlines / CRT', 'Scanlines, RGB mask and slight curvature.', 'Style', false),
  R('scanlineStrength', 'Scanline strength', 'Darkness of the scanlines.', 'Style', 0.35, 0, 1, 0.05),
  R('crtCurve', 'CRT curvature', 'Screen bulge.', 'Style', 0.15, 0, 1, 0.05),
  B('dither', 'Dither', 'Ordered dither to kill gradient banding.', 'Style', true),
  S('glitch', 'Glitch', 'Digital artifacts: off, on death, or always.', 'Style', 'death', [['off', 'Off'], ['death', 'On death'], ['always', 'Always']]),
  R('glitchStrength', 'Glitch strength', 'Size of block shifts and RGB tears.', 'Style', 1, 0, 2, 0.05),
  B('pixelate', 'Pixelation', 'Chunky pixel look.', 'Style', false),
  R('pixelSize', 'Pixel size', 'Pixel block size in screen pixels.', 'Style', 4, 2, 16, 1),

  // ---------------------------------------------------------------- Debug
  S('debugView', 'Buffer view', 'Show an intermediate buffer instead of the final frame.', 'Debug', 'final',
    [['final', 'Final'], ['depth', 'Depth'], ['normal', 'Normals'], ['velocity', 'Velocity'], ['bloom', 'Bloom only'], ['ao', 'AO'], ['ssr', 'Reflections'], ['fog', 'Fog / shafts'], ['particles', 'Particles']]),
  B('wireframe', 'Wireframe', 'Render world geometry as wireframe.', 'Debug', false),
  B('freezeTime', 'Freeze time', 'Pause simulation; camera and rendering keep running.', 'Debug', false),
  B('showReaction', 'Reaction boundary', 'Visualise the reaction-distance readability boundary.', 'Debug', false),
  R('reactionTime', 'Reaction time (s)', 'Seconds of travel that must stay readable through weather.', 'Debug', 1.0, 0.4, 2, 0.05),
  R('fogNearCap', 'Fog cap in reaction zone', 'Max fog opacity allowed inside the reaction distance.', 'Debug', 0.3, 0, 1, 0.05),
  B('godMode', 'No death', 'Ignore falls and collisions.', 'Debug', false),
  B('syncTiming', 'Sync per-pass timing', 'Stall the GPU after each pass to time it when timer queries are missing.', 'Debug', false),
];

export const BY_KEY = Object.fromEntries(SCHEMA.map((s) => [s.key, s]));

export const QUALITY_KEYS = ['renderScale', 'maxDpr', 'shadowQuality', 'reflectionQuality', 'particleCount', 'aa', 'fogSteps', 'aoSamples', 'ssrSteps',
  'dofSamples', 'mbSamples', 'bloomMips', 'lightPool', 'cityDensity', 'halfResEffects', 'ao', 'gi', 'volumetric', 'godrays', 'dof', 'motionBlur',
  'streaks', 'flare', 'halation', 'reflections', 'cas'];

export const PRESETS = {
  low: { renderScale: 0.7, maxDpr: 1, shadowQuality: 'blob', reflectionQuality: 'off', particleCount: 0.4, aa: 'fxaa', fogSteps: 6, aoSamples: 4,
    ssrSteps: 12, dofSamples: 8, mbSamples: 4, bloomMips: 4, lightPool: 4, cityDensity: 0.5, halfResEffects: true, ao: false, gi: false,
    volumetric: false, godrays: false, dof: false, motionBlur: false, streaks: false, flare: false, halation: false, reflections: false, cas: true },
  medium: { renderScale: 0.85, maxDpr: 1, shadowQuality: 'blob', reflectionQuality: 'planar', particleCount: 0.7, aa: 'smaa', fogSteps: 8, aoSamples: 6,
    ssrSteps: 20, dofSamples: 12, mbSamples: 6, bloomMips: 5, lightPool: 8, cityDensity: 0.75, halfResEffects: true, ao: true, gi: false,
    volumetric: true, godrays: true, dof: false, motionBlur: true, streaks: true, flare: false, halation: true, reflections: true, cas: true },
  high: { renderScale: 1, maxDpr: 1.5, shadowQuality: 'soft', reflectionQuality: 'ssr-low', particleCount: 1, aa: 'taa', fogSteps: 16, aoSamples: 8,
    ssrSteps: 32, dofSamples: 24, mbSamples: 8, bloomMips: 6, lightPool: 12, cityDensity: 1, halfResEffects: true, ao: true, gi: true,
    volumetric: true, godrays: true, dof: true, motionBlur: true, streaks: true, flare: true, halation: true, reflections: true, cas: true },
  ultra: { renderScale: 1, maxDpr: 2, shadowQuality: 'ultra', reflectionQuality: 'ssr-high', particleCount: 1.5, aa: 'taa', fogSteps: 24, aoSamples: 12,
    ssrSteps: 48, dofSamples: 36, mbSamples: 12, bloomMips: 7, lightPool: 16, cityDensity: 1, halfResEffects: false, ao: true, gi: true,
    volumetric: true, godrays: true, dof: true, motionBlur: true, streaks: true, flare: true, halation: true, reflections: true, cas: true },
};

export function defaults() {
  const o = Object.fromEntries(SCHEMA.map((s) => [s.key, s.def]));
  return { ...o, ...PRESETS.high, preset: 'high' };
}
