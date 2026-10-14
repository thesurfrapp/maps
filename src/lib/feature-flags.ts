// URL feature flags. The RN app opts in per app release by adding the param to the
// WebView URL, so app versions already in the field (which never send it) keep the
// map exactly as it was.

// `?stations=1` — live wind stations and the map style that goes with them:
// station layer, Windy-style taps (no pin on tap; long-press drops a draggable pin)
// and direction arrows on the gust overlay.
//
// Read once and cached: url.ts rewrites the query string during the session, and the
// flag must not change while the page is open.
let liveStations: boolean | undefined;

export const isLiveStationsEnabled = (): boolean => {
	if (liveStations === undefined) {
		liveStations =
			typeof window !== 'undefined' &&
			new URLSearchParams(window.location.search).get('stations') === '1';
	}
	return liveStations;
};
