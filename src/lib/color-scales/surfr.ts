import type { BreakpointColorScale } from '@openmeteo/weather-map-layer';

// Surfr wind color palette — hues from WindguruService.WIND_COLOR_ANCHORS in /frontend,
// linearly interpolated between anchors so the map renders a smooth gradient instead of
// hard bucket edges. ForecastTable cells still snap to discrete anchor colors, but at the
// anchor knots (0/5/10/…/50) the map shows the exact same hue, so palette parity holds at
// every bucket centre.

const KT_TO_MPS = 0.514444;

// Lower than 1 so basemap reads through the overlay. Global raster-opacity (default 0.75)
// multiplies on top — effective alpha at default settings is ~0.375.
const UNIFORM_ALPHA = 0.5;

// Anchors in knots — must stay in sync with WindguruService.WIND_COLOR_ANCHORS.
const anchors: [number, number, number, number][] = [
	[0, 80, 112, 192],
	[5, 64, 184, 200],
	[10, 80, 200, 120],
	[15, 144, 216, 64],
	[20, 208, 216, 40],
	[25, 232, 168, 48],
	[30, 224, 104, 72],
	[35, 224, 72, 152],
	[40, 208, 72, 192],
	[50, 136, 88, 200]
];

// Densify to 1-knot resolution. Each integer knot from 0 to 50 gets an interpolated color.
// Library does step lookup (findLastIndexLE); at 1-kt resolution the "steps" are too fine
// to see — result reads as a smooth gradient.
const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

const densified: { kt: number; rgb: [number, number, number] }[] = [];
for (let i = 0; i < anchors.length - 1; i++) {
	const [k0, r0, g0, b0] = anchors[i];
	const [k1, r1, g1, b1] = anchors[i + 1];
	const span = k1 - k0;
	for (let k = k0; k < k1; k++) {
		const t = (k - k0) / span;
		densified.push({ kt: k, rgb: [lerp(r0, r1, t), lerp(g0, g1, t), lerp(b0, b1, t)] });
	}
}
// Append the terminal anchor.
const last = anchors[anchors.length - 1];
densified.push({ kt: last[0], rgb: [last[1], last[2], last[3]] });

export const surfrWindScale: BreakpointColorScale = {
	type: 'breakpoint',
	unit: 'm/s',
	breakpoints: densified.map((d) => +(d.kt * KT_TO_MPS).toFixed(4)),
	colors: densified.map(({ rgb }) => [rgb[0], rgb[1], rgb[2], UNIFORM_ALPHA])
};
