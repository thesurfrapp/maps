import type { BreakpointColorScale } from '@openmeteo/weather-map-layer';

// Surfr wind color palette — hues from WindguruService.WIND_COLOR_ANCHORS in /frontend,
// linearly interpolated between anchors so the map renders a smooth gradient instead of
// hard bucket edges. ForecastTable cells still snap to discrete anchor colors, but at the
// anchor knots (0/5/10/…/50) the map shows the exact same hue, so palette parity holds at
// every bucket centre.

const KT_TO_MPS = 0.514444;

// Per-anchor alpha — ASCENDING ramp matching the arrow layer's pattern in
// layers.ts:makeArrowColor (arrows go 0.2 → 0.7 from calm to strong). Calm
// areas fade nearly transparent so the basemap dominates; only stronger winds
// build up to vivid color. Global raster-opacity preference multiplies on top.
// Anchors in knots — RGB synced with WindguruService.WIND_COLOR_ANCHORS in /frontend.
const anchors: [number, number, number, number, number][] = [
	// kt, R, G, B, alpha
	[0, 80, 112, 192, 0.05],
	[5, 64, 184, 200, 0.15],
	[10, 80, 200, 120, 0.3],
	[15, 144, 216, 64, 0.45],
	[20, 208, 216, 40, 0.6],
	[25, 232, 168, 48, 0.7],
	[30, 224, 104, 72, 0.75],
	[35, 224, 72, 152, 0.8],
	[40, 208, 72, 192, 0.85],
	[50, 136, 88, 200, 0.9]
];

// Densify to 1-knot resolution. Both RGB and alpha are interpolated between
// anchors. Library does step lookup (findLastIndexLE); at 1-kt resolution the
// "steps" are too fine to see — the result reads as a smooth gradient.
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpInt = (a: number, b: number, t: number): number => Math.round(lerp(a, b, t));

const densified: { kt: number; rgba: [number, number, number, number] }[] = [];
for (let i = 0; i < anchors.length - 1; i++) {
	const [k0, r0, g0, b0, a0] = anchors[i];
	const [k1, r1, g1, b1, a1] = anchors[i + 1];
	const span = k1 - k0;
	for (let k = k0; k < k1; k++) {
		const t = (k - k0) / span;
		densified.push({
			kt: k,
			rgba: [lerpInt(r0, r1, t), lerpInt(g0, g1, t), lerpInt(b0, b1, t), +lerp(a0, a1, t).toFixed(3)]
		});
	}
}
// Append the terminal anchor.
const last = anchors[anchors.length - 1];
densified.push({ kt: last[0], rgba: [last[1], last[2], last[3], last[4]] });

export const surfrWindScale: BreakpointColorScale = {
	type: 'breakpoint',
	unit: 'm/s',
	breakpoints: densified.map((d) => +(d.kt * KT_TO_MPS).toFixed(4)),
	colors: densified.map(({ rgba }) => rgba)
};
