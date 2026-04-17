// Domain and variable defaults. Public standalone UI only supports three
// overlays (wind / gusts / rain) via `OverlayPills`, so defaults must resolve
// to a variable one of those pills renders. GFS 0.13° is the default model —
// widest coverage, fastest-warming domain in our rotation.
export const DEFAULT_DOMAIN = 'ncep_gfs013';
export const DEFAULT_VARIABLE = 'wind_u_component_10m';

// Variables that the simplified UI's pills can display. Anything else is
// coerced back to DEFAULT_VARIABLE on load (see `urlParamsToPreferences`).
// Keep in sync with `OVERLAY_VARIABLE_ALIASES` in
// `src/lib/components/overlay-pills/overlay-pills.svelte`.
export const SUPPORTED_OVERLAY_VARIABLES = [
	'wind_speed_10m',
	'wind_u_component_10m',
	'wind_gusts_10m',
	'rain',
	'precipitation'
] as const;

// Vector options defaults
export const DEFAULT_VECTOR_OPTIONS = {
	grid: false,
	arrows: true,
	contours: false,
	breakpoints: true,
	contourInterval: 2
};

// Preferences defaults
export const DEFAULT_PREFERENCES = {
	globe: false,
	terrain: false,
	hillshade: false,
	clipWater: false,
	showScale: true
};

// Layer names for map rendering.
// These are insertion points ("beforeId") used by map.addLayer(...) so our weather
// raster and vector arrow layers land below place labels. They must reference a
// layer that exists in the active basemap style — we use OpenFreeMap Positron.
export const HILLSHADE_LAYER = 'hillshadeLayer';
export const BEFORE_LAYER_RASTER = 'waterway_line_label';
export const BEFORE_LAYER_VECTOR = 'waterway_line_label';
export const BEFORE_LAYER_VECTOR_WATER_CLIP = 'waterway_line_label';

// Default tile size and opacity
export const DEFAULT_TILE_SIZE = 512;
export const DEFAULT_OPACITY = 75;

// Cache defaults (in KB and MB for UI display)
// Bumped from 64 → 192 KB. Each range-GET pulls 3× more data, so the library
// fires ~3× fewer requests per viewport render. Less HTTP/2 multiplexing
// contention, less CF-edge cold-miss risk on first-time viewports, and the
// extra bytes are negligible over modern mobile networks.
export const DEFAULT_CACHE_BLOCK_SIZE_KB = 192;
export const DEFAULT_CACHE_MAX_BYTES_MB = 400;

// Measured HTTP/2 overhead per range request (~1342 bytes: HPACK headers + framing).
// Rounded up to 1408 for safety margin (Range/Content-Range header lengths vary with file offset).
// Subtracted from block size so total transfer fits within the nominal KiB boundary.
export const HTTP_OVERHEAD_BYTES = 1408;

// Complete default values for URL parameter checking
export const COMPLETE_DEFAULT_VALUES: { [key: string]: boolean | string | number } = {
	domain: DEFAULT_DOMAIN,
	variable: DEFAULT_VARIABLE,
	...DEFAULT_PREFERENCES,
	...DEFAULT_VECTOR_OPTIONS
};

// Time constants
export const MILLISECONDS_PER_SECOND = 1000; // 1 second in milliseconds
export const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND; // 1 minute in milliseconds
export const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE; // 1 hour in milliseconds
export const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR; // 1 day in milliseconds
export const MILLISECONDS_PER_WEEK = 7 * MILLISECONDS_PER_DAY; // 7 days in milliseconds

// Metadata refresh interval
export const METADATA_REFRESH_INTERVAL = 5 * MILLISECONDS_PER_MINUTE; // 5 minutes in milliseconds

// Calendar display constants
export const DAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
];
