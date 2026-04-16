import type { BreakpointColorScale } from '@openmeteo/weather-map-layer';

// Surfr wind color palette — hues from WindguruService.WIND_COLOR_ANCHORS in /frontend,
// linearly interpolated between anchors so the map renders a smooth gradient instead of
// hard bucket edges. ForecastTable cells still snap to discrete anchor colors, but at the
// anchor knots (0/5/10/…/50) the map shows the exact same hue, so palette parity holds at
// every bucket centre.

const KT_TO_MPS = 0.514444;

// Per-anchor alpha — still ascending (strong winds are more opaque than calm)
// but with a higher floor so the calm-blue/cyan end stays visible on the dark
// basemap. The original 0.05 floor made 0–5 kt effectively invisible over
// OpenFreeMap's dark style; raised to 0.35 so calm sits readably over both
// light and dark basemaps. Global raster-opacity preference still multiplies
// on top.
//
// RGB hues come from WindguruService.WIND_COLOR_ANCHORS in /frontend, but each
// anchor's dominant channel is pushed to 255. The forecast-table cells in RN
// render against their own solid backgrounds so the original mid-saturated
// values work there; the MAP renders over a dark basemap where those same
// RGBs read as muddy. Boosting to max brightness per anchor preserves hue
// family (blue-cyan-green-lime-yellow-orange-red-pink-magenta-purple) but
// makes each band pop against black.
const anchors: [number, number, number, number, number][] = [
	// kt, R, G, B, alpha
	[0, 106, 149, 255, 0.35], //  blue (was 80,112,192)
	[5, 82, 235, 255, 0.45], //   cyan (was 64,184,200)
	[10, 102, 255, 153, 0.55], // green (was 80,200,120)
	[15, 170, 255, 75, 0.65], //  lime (was 144,216,64)
	[20, 245, 255, 47, 0.7], //   yellow (was 208,216,40)
	[25, 255, 185, 53, 0.75], //  orange (was 232,168,48)
	[30, 255, 118, 82, 0.8], //   red-orange (was 224,104,72)
	[35, 255, 82, 173, 0.85], //  pink (was 224,72,152)
	[40, 255, 88, 235, 0.9], //   magenta (was 208,72,192)
	[50, 173, 112, 255, 0.95] //  purple (was 136,88,200)
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
