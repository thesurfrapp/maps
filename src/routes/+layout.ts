export const prerender = true;
export const trailingSlash = 'never';
// This site renders MapLibre GL JS and touches window/navigator from the top level of
// several components (e.g. time-selector.svelte). Disable SSR to avoid ReferenceErrors
// during prerender and `vite dev`. The app is a pure client-side map app.
export const ssr = false;
