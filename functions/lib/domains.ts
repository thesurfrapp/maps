// Tile-domain names the warmer keeps fresh in R2. Must stay in sync with the
// frontend's openMeteoMapConfig.OM_MODEL_TO_TILE_DOMAIN. Canonical list of
// names lives in @openmeteo/weather-map-layer/src/domains.ts.
//
// Adding a new domain: append here, push, wait for next cron tick (≤5 min).
// Removing a domain: remove here, then delete its R2 prefix manually (the
// warmer never deletes domains it doesn't know about).

export const WARMED_DOMAINS: readonly string[] = [
	'metno_nordic_pp',
	'meteofrance_arome_france_hd',
	'dwd_icon_d2',
	'knmi_harmonie_arome_netherlands',
	'ukmo_uk_deterministic_2km',
	'meteofrance_arome_france0025',
	'cmc_gem_hrdps',
	'ncep_hrrr_conus',
	'knmi_harmonie_arome_europe',
	'ecmwf_ifs025',
	'dwd_icon',
	// GFS splits wind/rain (013) from gusts (025) — frontend handles both.
	'ncep_gfs013',
	'ncep_gfs025'
];
