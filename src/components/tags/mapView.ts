// Where the location map opens, kept out of the component so it can be
// tested without Leaflet.

export interface LatLon {
  latitude: number
  longitude: number
}

export interface MapView {
  center: [number, number]
  zoom: number
}

/**
 * The view the map opens with: on the location's position, zoomed so its
 * circle (`radiusMetres`) fits comfortably; else on the nearest ancestor that
 * has a position (a city around a new store); else the whole world.
 */
export function initialView(
  position: LatLon | null,
  radiusMetres: number,
  fallback: LatLon | null,
): MapView {
  if (position) {
    // At zoom 18 the map shows about 300 m across a phone; each step out doubles it.
    const zoom = Math.max(
      3,
      Math.min(18, 18 - Math.ceil(Math.log2(Math.max(1, radiusMetres / 50)))),
    )
    return { center: [position.latitude, position.longitude], zoom }
  }
  if (fallback) return { center: [fallback.latitude, fallback.longitude], zoom: 13 }
  return { center: [20, 0], zoom: 2 }
}

/** A coordinate picked on the map, to six decimals (about 10 cm: more than a click can tell). */
export function roundCoordinate(degrees: number): number {
  return Number(degrees.toFixed(6))
}
