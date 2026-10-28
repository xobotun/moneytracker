<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type * as Leaflet from 'leaflet'
import { initialView, roundCoordinate, type LatLon } from './mapView'

/**
 * An OpenStreetMap map for picking a location's position: a click puts the
 * pin there, the pin can be dragged, and the radius shows as a circle.
 * Leaflet and its tiles load only when the map is shown.
 */
const props = defineProps<{
  latitude: number | null
  longitude: number | null
  radius: number
  /** Where to open when the location has no position yet (an ancestor's). */
  fallback: LatLon | null
}>()
const emit = defineEmits<{ pick: [latitude: number, longitude: number] }>()

const container = useTemplateRef<HTMLDivElement>('container')
const failed = ref(false)

let L: typeof Leaflet | null = null
let map: Leaflet.Map | null = null
let pin: Leaflet.Marker | null = null
let circle: Leaflet.Circle | null = null
let resizes: ResizeObserver | null = null

const position = (): LatLon | null =>
  props.latitude !== null && props.longitude !== null
    ? { latitude: props.latitude, longitude: props.longitude }
    : null

function pick(at: Leaflet.LatLng) {
  emit('pick', roundCoordinate(at.lat), roundCoordinate(at.lng))
}

/** Puts the pin and the circle where the props say, or removes them. */
function draw() {
  if (!L || !map) return
  const at = position()
  if (!at) {
    pin?.remove()
    circle?.remove()
    pin = circle = null
    return
  }
  const latLng = L.latLng(at.latitude, at.longitude)
  if (!pin) {
    pin = L.marker(latLng, {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: 'location-map-pin', iconSize: [18, 18] }),
    })
      .on('dragend', () => pick(pin!.getLatLng()))
      .addTo(map)
    circle = L.circle(latLng, {
      radius: props.radius,
      color: 'var(--p-primary-color)',
      weight: 1,
      fillOpacity: 0.15,
      interactive: false,
    }).addTo(map)
  } else {
    pin.setLatLng(latLng)
    circle!.setLatLng(latLng).setRadius(props.radius)
  }
}

onMounted(async () => {
  try {
    L = await import('leaflet')
    await import('leaflet/dist/leaflet.css')
  } catch {
    failed.value = true // offline and never loaded: the coordinates still work
    return
  }
  if (!container.value) return
  const view = initialView(position(), props.radius, props.fallback)
  map = L.map(container.value, { attributionControl: false }).setView(view.center, view.zoom)
  L.control.attribution({ prefix: false }).addTo(map)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map)
  map.on('click', (event: Leaflet.LeafletMouseEvent) => pick(event.latlng))
  draw()
  // The dialog sizes the map after it opens; Leaflet needs to hear of it.
  resizes = new ResizeObserver(() => map?.invalidateSize())
  resizes.observe(container.value)
})

// A position set from outside (typed, "Use my position") brings the view to
// it: zoomed in to the place when the map shows a wide area, else panned to
// it when it is out of sight.
watch(
  () => [props.latitude, props.longitude, props.radius] as const,
  ([lat, lon], [oldLat, oldLon]) => {
    draw()
    if (!map || lat === null || lon === null || (lat === oldLat && lon === oldLon)) return
    const placeView = initialView({ latitude: lat, longitude: lon }, props.radius, null)
    if (map.getZoom() < placeView.zoom - 4) map.setView(placeView.center, placeView.zoom)
    else if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon])
  },
)

onBeforeUnmount(() => {
  resizes?.disconnect()
  map?.remove()
  map = null
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <div
      ref="container"
      class="location-map h-56 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700"
      role="application"
      aria-label="Map: click to put the location's pin there, or drag the pin"
    />
    <small v-if="failed" class="text-red-600">The map could not load; type the coordinates.</small>
    <small v-else class="text-gray-500 dark:text-gray-400">
      Click the map to put the pin there, or drag the pin.
    </small>
  </div>
</template>

<!-- Not scoped: Leaflet builds the map's DOM itself, outside Vue's scope. -->
<style>
/* The pin: a dot in the primary colour, not Leaflet's image marker. */
.location-map .location-map-pin {
  border: 3px solid white;
  border-radius: 9999px;
  background: var(--p-primary-color);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
}

/* Darker tiles in the dark theme. */
.dark .location-map .leaflet-tile-pane {
  filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9);
}
</style>
