<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type * as Leaflet from 'leaflet'
import type { ShortId } from '@/db/shortId'
import { accountIconClass, iconColourOn } from '@/components/accounts/accountForm'
import { circleStyle, type MapLocation } from '@/tags/locationsMap'
import { createOsmMap, loadLeaflet, loadMarkerClusters, type LeafletModule } from './osm'

/**
 * An OpenStreetMap map of many locations: each one's circle, and its icon at
 * the centre (clustered while they crowd). A tap on an icon asks to edit the
 * location. Built for a thousand locations: the circles share one canvas, the
 * icons sit in Leaflet.markercluster, and a change redraws them in bulk.
 * Leaflet and the plugin load only when the map is shown.
 */
const props = defineProps<{
  /** What to show, largest circle first (`mapLocations`). */
  locations: MapLocation[]
}>()
const emit = defineEmits<{ edit: [id: ShortId] }>()

const container = useTemplateRef<HTMLDivElement>('container')
const failed = ref(false)

const ICON_SIZE = 28
const WORLD: Leaflet.LatLngExpression = [20, 0]

let L: LeafletModule | null = null
let map: Leaflet.Map | null = null
let circles: Leaflet.LayerGroup | null = null
let icons: Leaflet.MarkerClusterGroup | null = null
let renderer: Leaflet.Canvas | null = null
let hasView = false
let shownBefore = 0

/** The location's badge, like `AccountBadge`: its icon on a disc of its colour. */
function badgeIcon(location: MapLocation): Leaflet.DivIcon {
  // Built as elements, not HTML text: the colour is user data.
  const disc = document.createElement('span')
  disc.className = 'locations-map-disc'
  disc.style.backgroundColor = location.colour
  disc.style.color = iconColourOn(location.colour)
  const glyph = document.createElement('span')
  glyph.className = accountIconClass(location.icon)
  glyph.setAttribute('aria-hidden', 'true')
  disc.append(glyph)
  return L!.divIcon({
    html: disc,
    className: 'locations-map-icon',
    iconSize: [ICON_SIZE, ICON_SIZE],
  })
}

/** Text for a tooltip: Leaflet would read a string as HTML. */
function plainText(text: string): HTMLElement {
  const span = document.createElement('span')
  span.textContent = text
  return span
}

function iconMarker(location: MapLocation, at: Leaflet.LatLng): Leaflet.Marker {
  const { id, name } = location.tag
  const marker = L!.marker(at, { icon: badgeIcon(location), keyboard: true })
  // Shown on hover and on keyboard focus.
  marker.bindTooltip(() => plainText(name), { direction: 'top', offset: [0, -ICON_SIZE / 2] })
  marker.on('click', () => emit('edit', id))
  marker.on('keypress', (event: Leaflet.LeafletKeyboardEvent) => {
    if (event.originalEvent.key === 'Enter') emit('edit', id)
  })
  // The cluster group puts a marker's element in the page only while it is
  // not clustered, and may make a new one each time.
  marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `Edit ${name}`))
  return marker
}

/**
 * Redraws every circle and icon. Keeps the view the person chose, except that
 * the map fits all the locations when there were none before (the first draw
 * included); with none at all it shows the whole world.
 */
function draw() {
  if (!L || !map || !circles || !icons || !renderer) return
  const circleLayers: Leaflet.Circle[] = []
  const iconLayers: Leaflet.Marker[] = []
  let bounds: Leaflet.LatLngBounds | null = null
  for (const location of props.locations) {
    const at = L.latLng(location.latitude, location.longitude)
    circleLayers.push(
      L.circle(at, {
        radius: location.radius,
        renderer,
        interactive: false, // a city's circle must not swallow taps on the stores in it
        ...circleStyle(location.colour, location.autoMatch),
      }),
    )
    iconLayers.push(iconMarker(location, at))
    const extent = at.toBounds(2 * location.radius)
    bounds = bounds ? bounds.extend(extent) : extent
  }
  circles.clearLayers()
  icons.clearLayers()
  for (const circle of circleLayers) circles.addLayer(circle)
  icons.addLayers(iconLayers)

  if (bounds && shownBefore === 0) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 })
  else if (!hasView) map.setView(WORLD, 2)
  hasView = true
  shownBefore = props.locations.length
}

onMounted(async () => {
  let markerClusterGroup: LeafletModule['markerClusterGroup']
  try {
    L = await loadLeaflet()
    markerClusterGroup = await loadMarkerClusters(L)
  } catch {
    failed.value = true // offline and never loaded
    return
  }
  if (!container.value) return // left the page while loading
  map = createOsmMap(L, container.value)
  renderer = L.canvas({ padding: 0.5 })
  circles = L.layerGroup()
  icons = markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 18 })
  draw() // sets the view before the layers go on the map
  circles.addTo(map)
  icons.addTo(map)
})

watch(() => props.locations, draw)

onBeforeUnmount(() => {
  map?.remove()
  map = circles = icons = renderer = null
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <div
      ref="container"
      class="locations-map h-[70dvh] min-h-96 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700"
      role="region"
      aria-label="Map of the locations: select an icon to edit that location"
    />
    <small v-if="failed" class="text-red-600">
      The map could not load. Switch to Slim or Detailed for the list.
    </small>
  </div>
</template>

<!-- Not scoped: Leaflet builds the map's DOM itself, outside Vue's scope. -->
<style>
/* A location's icon: its badge, with room for a focus ring. */
.locations-map .locations-map-icon {
  border-radius: 9999px;
}
.locations-map .locations-map-icon:hover .locations-map-disc {
  box-shadow:
    0 0 0 2px var(--p-primary-color),
    0 1px 4px rgb(0 0 0 / 0.4);
}
.locations-map .locations-map-icon:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
.locations-map .locations-map-disc {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  border: 2px solid white;
  border-radius: 9999px;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  font-size: 0.8rem;
}
</style>
