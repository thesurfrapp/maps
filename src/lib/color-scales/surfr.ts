import type { BreakpointColorScale } from '@openmeteo/weather-map-layer';

// Surfr wind color palette — mirror of WindguruService.WIND_COLOR_ANCHORS in /frontend.
// Breakpoints are converted from knots to m/s (1 kt = 0.514444 m/s) so colors line up
// with the ForecastTable at the same wind speed in knots.
// Library lookup is step-function (findLastIndexLE), matching the table's "nearest lower anchor" rule.

const KT_TO_MPS = 0.514444;

const anchors: { kt: number; rgb: [number, number, number]; a: number }[] = [
	{ kt: 0, rgb: [80, 112, 192], a: 0 },
	{ kt: 5, rgb: [64, 184, 200], a: 0.55 },
	{ kt: 10, rgb: [80, 200, 120], a: 0.7 },
	{ kt: 15, rgb: [144, 216, 64], a: 0.85 },
	{ kt: 20, rgb: [208, 216, 40], a: 1 },
	{ kt: 25, rgb: [232, 168, 48], a: 1 },
	{ kt: 30, rgb: [224, 104, 72], a: 1 },
	{ kt: 35, rgb: [224, 72, 152], a: 1 },
	{ kt: 40, rgb: [208, 72, 192], a: 1 },
	{ kt: 50, rgb: [136, 88, 200], a: 1 }
];

export const surfrWindScale: BreakpointColorScale = {
	type: 'breakpoint',
	unit: 'm/s',
	breakpoints: anchors.map((a) => +(a.kt * KT_TO_MPS).toFixed(4)),
	colors: anchors.map(({ rgb, a }) => [rgb[0], rgb[1], rgb[2], a])
};
