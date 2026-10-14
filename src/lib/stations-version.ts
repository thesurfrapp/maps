// Version rule between the two station files (SRF-2994).
//
// `live-cluster` (positions + bubbles) and `readings` (values) carry the same `v`
// when they describe the same station set. Readings applied against another
// version's positions put values on the wrong stations or drop new ones.

/** Readings need a different positions file than the one on screen. */
export const needsBaseReload = (baseVersion: number | null, readingsV: unknown): boolean =>
	typeof readingsV === 'number' && baseVersion !== null && readingsV !== baseVersion;

/**
 * Readings may be painted on the positions on screen. Files without a version
 * (older formats) are trusted, as before.
 */
export const readingsMatchBase = (baseVersion: number | null, readingsV: unknown): boolean =>
	typeof readingsV !== 'number' || baseVersion === null || readingsV === baseVersion;
