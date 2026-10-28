import type * as Leaflet from 'leaflet'

// OpenStreetMap maps with Leaflet, shared by the location picker and the map
// of all locations. Leaflet, its plugins and their stylesheets load only when
// a map is shown, so the rest of the app never downloads them.

export type LeafletModule = typeof Leaflet

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/** Leaflet with its stylesheet and the app's map styles (darker tiles in the dark theme). */
export async function loadLeaflet(): Promise<LeafletModule> {
  const [leaflet] = await Promise.all([
    import('leaflet'),
    import('leaflet/dist/leaflet.css'),
    import('./osm.css'),
  ])
  return leaflet
}

/**
 * An OpenStreetMap map in `container`, with the attribution its tiles need.
 * It has no view yet: set one next (`setView`, `fitBounds`); nothing loads
 * before that. It follows the container's size, which a dialog or a layout
 * may change after the map is made.
 */
export function createOsmMap(L: LeafletModule, container: HTMLElement): Leaflet.Map {
  container.classList.add('osm-map')
  const map = L.map(container, { attributionControl: false })
  L.control.attribution({ prefix: false }).addTo(map)
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map)
  const resizes = new ResizeObserver(() => map.invalidateSize())
  resizes.observe(container)
  map.on('unload', () => resizes.disconnect())
  return map
}

/**
 * Leaflet.markercluster's `markerClusterGroup`. The plugin is a UMD script
 * that extends the global `L`: Leaflet's own build puts itself there (an
 * object the plugin can add to, unlike an ES module namespace), so `L` from
 * `loadLeaflet` only stands in when it is missing.
 */
export async function loadMarkerClusters(
  L: LeafletModule,
): Promise<LeafletModule['markerClusterGroup']> {
  const page = window as Window & { L?: LeafletModule }
  page.L ??= L
  await Promise.all([
    import('leaflet.markercluster'),
    import('leaflet.markercluster/dist/MarkerCluster.css'),
    import('leaflet.markercluster/dist/MarkerCluster.Default.css'),
  ])
  const extended = page.L
  if (typeof extended.markerClusterGroup !== 'function') {
    throw new Error('Leaflet.markercluster did not load')
  }
  return (options) => extended.markerClusterGroup(options)
}
