export interface Memory {
  id: string
  imageUrl: string
  lat: number
  lon: number
  headingDeg: number
  timestamp: number
  city: string
  destinationLabel: string | null
  reason: 'periodic' | 'arrival' | 'manual'
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

// Reuses the Street View panorama ID already resolved for Seekr's current
// position (no new "nearest panorama" search) when available; otherwise
// falls back to a location-based lookup so a memory can still be captured.
export function streetViewImageUrl(
  lat: number,
  lon: number,
  headingDeg: number,
  panoId: string | null,
): string {
  const params = new URLSearchParams({
    size: '320x200',
    heading: String(headingDeg),
    pitch: '0',
    key: GOOGLE_MAPS_API_KEY ?? '',
  })
  if (panoId) {
    params.set('pano', panoId)
  } else {
    params.set('location', `${lat},${lon}`)
  }
  return `https://maps.googleapis.com/maps/api/streetview?${params}`
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
