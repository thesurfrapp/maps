import type { BreakpointColorScale } from '@openmeteo/weather-map-layer';

// Surfr wind color palette — hues from WindguruService.WIND_COLOR_ANCHORS in /frontend,
// linearly interpolated between anchors so the map renders a smooth gradient instead of
// hard bucket edges. ForecastTable cells still snap to discrete anchor colors, but at the
// anchor knots (0/5/10/…/50) the map shows the exact same hue, so palette parity holds at
// every bucket centre.

const KT_TO_MPS = 0.514444;

// Global darkening factor applied to all wind anchors before they're rasterised
// onto the map. Pushes the whole palette toward black so the overlay reads
// heavier on light basemaps (Voyager, Streets-light) where the original hues
// felt washed out. Hue family is preserved — only value drops. 1.0 = original,
// 0.5 = half-brightness. Tune this one number to reshade the whole ramp.
const WIND_DARKEN = 1.0;

// Embed-only multiplier stacked on top of WIND_DARKEN. The mobile WebView
// over MapTiler reads brighter than desktop because per-pixel alpha is
// ignored on that pipeline (see anchorsEmbed comment), so we knock the
// whole ramp down here without affecting the standalone web view. Tune this
// to taste — lower = darker. 1.0 = no extra darkening.
const EMBED_WIND_DARKEN = 0.85;

// If non-null, override every anchor's alpha with this value. Useful for
// quick "what if every wind band was X% transparent" tests. Set to null to
// keep the per-anchor alpha curve (ascending with wind strength).
// Caveat: the RN WebView's WebGL pipeline is known to ignore per-pixel alpha
// from the color-scale texture — overlay dimming in the embed happens via
// ?opacity=… instead. So changes here may only be visible in the desktop
// browser view.
const WIND_ALPHA_OVERRIDE: number | null = null;

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
	[0, 106, 149, 255, 0.4], //   blue          a=0.40
	[5, 82, 235, 255, 0.5], //    cyan          a=0.50
	[10, 102, 255, 153, 0.55], // green         a=0.55
	[15, 170, 255, 75, 0.6], //   lime          a=0.60
	[20, 245, 255, 47, 0.7], //   yellow        a=0.70
	[25, 255, 185, 53, 0.75], //  orange        a=0.75
	[30, 255, 118, 82, 0.8], //   red-orange    a=0.80
	[35, 255, 82, 173, 0.85], //  pink          a=0.85
	[40, 255, 88, 235, 0.9], //   magenta       a=0.90
	[50, 173, 112, 255, 1.0] //   purple        a=1.00
];

// Embed-only variant for the RN WebView.
//
// Why: the mobile WebView's WebGL pipeline ignores per-pixel alpha from the
// color-scale texture (verified empirically — setting every anchor's alpha to
// 0.1 leaves the mobile map fully vivid while desktop goes nearly invisible;
// see raster.fragment.glsl's `rgb / alpha` un-premultiply step + WebKit's
// non-standard `createImageBitmap` premultiplication handling). We can't rely
// on alpha there, so the "calm fades dark, strong stays vivid" contrast has
// to live entirely in the RGB channel: all anchors get alpha=1, low-knot
// hues are darkened toward black, high-knot hues keep their original Surfr
// RGB (already max-saturated per hue — one channel pinned at 255), middle
// (20–25 kt) is untouched.
//
// Same knot breakpoints + hue families as the main scale, and anchors ≥20 kt
// match the desktop scale byte-for-byte so forecast-table / legend / map stay
// aligned on the hot half of the ramp.
const anchorsEmbed: [number, number, number, number, number][] = [
	// Alpha is pinned to 1 because the RN WebView's WebGL pipeline ignores
	// per-pixel alpha from the color-scale texture — overall overlay dimming
	// is done RN-side via `?opacity=…`. To compensate for that fixed alpha,
	// anchors below 20 kt are darkened toward black so calm conditions still
	// read as "less intense" even without an alpha gradient. ≥20 kt stays
	// byte-for-byte identical to the desktop scale.
	//
	// Anchor knots also shifted: cyan 5 → 8 kt, green 10 → 12 kt. This pushes
	// the cold-to-warm transition later in the ramp so "green" maps to rideable
	// conditions rather than still-calm.
	[0, 64, 89, 153, 1], //    blue        (106,149,255 × 0.60)
	[8, 110, 221, 235, 1], //  cyan        (desktop 82,235,255 × 0.9, then blended 20% toward white) — was at 5 kt
	[12, 82, 204, 122, 1], //  green       (102,255,153 × 0.80) — was at 10 kt
	[15, 153, 230, 68, 1], //  lime        (170,255,75  × 0.90)
	[20, 245, 255, 47, 1], //  yellow      (= desktop)
	[25, 255, 185, 53, 1], //  orange      (= desktop)
	[30, 255, 118, 82, 1], //  red-orange  (= desktop)
	[35, 255, 82, 173, 1], //  pink        (= desktop)
	[40, 255, 88, 235, 1], //  magenta     (= desktop)
	[50, 173, 112, 255, 1] //  purple      (= desktop)
];

// Densify to 1-knot resolution. Both RGB and alpha are interpolated between
// anchors. Library does step lookup (findLastIndexLE); at 1-kt resolution the
// "steps" are too fine to see — the result reads as a smooth gradient.
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpInt = (a: number, b: number, t: number): number => Math.round(lerp(a, b, t));

function densify(
	src: [number, number, number, number, number][],
	extraDarken = 1.0
): BreakpointColorScale {
	const factor = WIND_DARKEN * extraDarken;
	const d = (c: number): number => Math.round(c * factor);
	const out: { kt: number; rgba: [number, number, number, number] }[] = [];
	const alphaFor = (a: number): number =>
		WIND_ALPHA_OVERRIDE == null ? a : WIND_ALPHA_OVERRIDE;
	for (let i = 0; i < src.length - 1; i++) {
		const [k0, r0, g0, b0, a0] = src[i];
		const [k1, r1, g1, b1, a1] = src[i + 1];
		const span = k1 - k0;
		for (let k = k0; k < k1; k++) {
			const t = (k - k0) / span;
			out.push({
				kt: k,
				rgba: [
					d(lerpInt(r0, r1, t)),
					d(lerpInt(g0, g1, t)),
					d(lerpInt(b0, b1, t)),
					+alphaFor(lerp(a0, a1, t)).toFixed(3)
				]
			});
		}
	}
	// Append the terminal anchor (also darkened).
	const last = src[src.length - 1];
	out.push({ kt: last[0], rgba: [d(last[1]), d(last[2]), d(last[3]), alphaFor(last[4])] });
	return {
		type: 'breakpoint',
		unit: 'm/s',
		breakpoints: out.map((d) => +(d.kt * KT_TO_MPS).toFixed(4)),
		colors: out.map(({ rgba }) => rgba)
	};
}

export const surfrWindScale: BreakpointColorScale = densify(anchors);
export const surfrWindScaleEmbed: BreakpointColorScale = densify(anchorsEmbed, EMBED_WIND_DARKEN);
