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
  memoriesId: string | null
  memoriesStatus: 'pending' | 'stored' | 'error'
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

const MEMORY_API_BASE_URL = import.meta.env.VITE_MEMORY_API_BASE_URL as
  | string
  | undefined

// Sends the already-captured image (no new Street View request) to our
// backend, which uploads/indexes it in the Memories.ai private library.
// Never touches MEMORIES_API_KEY - that stays server-side.
export async function storeMemoryRemotely(memory: Memory): Promise<string | null> {
  if (!MEMORY_API_BASE_URL) return null
  const response = await fetch(`${MEMORY_API_BASE_URL}/api/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: memory.imageUrl,
      lat: memory.lat,
      lon: memory.lon,
      timestamp: memory.timestamp,
      city: memory.city,
      destinationLabel: memory.destinationLabel,
    }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error ?? `Store request failed (${response.status})`)
  }
  return json.memoriesId ?? null
}

export interface RemoteSearchMatch {
  id: string | null
}

export async function searchMemoriesRemotely(
  query: string,
): Promise<RemoteSearchMatch[]> {
  if (!MEMORY_API_BASE_URL) return []
  const response = await fetch(`${MEMORY_API_BASE_URL}/api/memories/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error ?? `Search request failed (${response.status})`)
  }
  return json.results ?? []
}

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
