import { loadGeocodingLibrary } from './googleMaps'

export interface Memory {
  id: string
  imageUrl: string
  lat: number
  lon: number
  headingDeg: number
  timestamp: number
  city: string
  // Human-readable label for THIS memory's actual capture coordinates
  // (reverse-geocoded), never the route origin/destination text.
  locationLabel: string | null
  locationStatus: 'pending' | 'resolved' | 'error'
  // One-sentence description of what's visible in the captured image,
  // generated once at capture time via the backend's Claude vision call.
  description: string | null
  descriptionStatus: 'pending' | 'resolved' | 'error'
  reason: 'periodic' | 'arrival' | 'manual'
  memoriesId: string | null
  memoriesStatus: 'pending' | 'stored' | 'error'
  notes: string[]
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

const MEMORY_API_BASE_URL = import.meta.env.VITE_MEMORY_API_BASE_URL as
  | string
  | undefined

// Strips the trailing ", USA"/", United States" and a trailing ZIP code so
// the label stays close to the examples in the spec (street/venue, city)
// rather than a full postal address.
function simplifyFormattedAddress(address: string): string {
  return address
    .replace(/,\s*(United States|USA)$/i, '')
    .replace(/,?\s*\d{5}(-\d{4})?$/, '')
    .trim()
}

// Reverse-geocodes Seekr's actual capture-time coordinates into a concise,
// human-readable label via the existing Google Geocoder (already used
// elsewhere in the app for forward geocoding) - no new API/key needed.
// Never blocks memory creation: callers treat this as fire-and-forget and
// fall back to formatted coordinates on any failure.
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const fallback = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
  if (!GOOGLE_MAPS_API_KEY) return fallback
  try {
    const { Geocoder } = await loadGeocodingLibrary(GOOGLE_MAPS_API_KEY)
    const response = await new Geocoder().geocode({ location: { lat, lng: lon } })
    const result = response.results[0]
    if (!result?.formatted_address) return fallback
    return simplifyFormattedAddress(result.formatted_address)
  } catch (error) {
    console.warn('Reverse geocoding failed:', error)
    return fallback
  }
}

// Asks the backend for a short, one-sentence description of what's visible
// in the captured Street View image. Backend keeps ANTHROPIC_API_KEY
// server-side; this never touches the key directly.
export async function describeMemoryImage(imageUrl: string): Promise<string> {
  if (!MEMORY_API_BASE_URL) {
    throw new Error('VITE_MEMORY_API_BASE_URL is not configured')
  }
  const response = await fetch(`${MEMORY_API_BASE_URL}/api/describe-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error ?? `Describe request failed (${response.status})`)
  }
  return json.description ?? ''
}

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
      locationLabel: memory.locationLabel,
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

export interface ChatReply {
  answer: string
  memoryId?: string
}

// Sends the user's message plus local memory metadata/notes to our backend,
// which grounds the reply via Memories.ai search + Claude. No Anthropic or
// Memories.ai credentials touch the browser.
export async function sendChatMessage(
  message: string,
  currentMemoryId: string | null,
  memories: Memory[],
): Promise<ChatReply> {
  if (!MEMORY_API_BASE_URL) {
    throw new Error('VITE_MEMORY_API_BASE_URL is not configured')
  }
  const response = await fetch(`${MEMORY_API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      currentMemoryId,
      memories: memories.map((m) => ({
        id: m.id,
        memoriesId: m.memoriesId,
        city: m.city,
        locationLabel: m.locationLabel,
        description: m.description,
        lat: m.lat,
        lon: m.lon,
        timestamp: m.timestamp,
        notes: m.notes,
      })),
    }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json?.answer) {
    throw new Error(json?.error ?? `Chat request failed (${response.status})`)
  }
  return { answer: json.answer, memoryId: json.memoryId }
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
