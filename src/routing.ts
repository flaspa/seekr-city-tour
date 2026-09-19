// Minimal wrapper around Google's Routes API `computeRoutes` REST endpoint
// (current official replacement for the legacy Directions service).
// https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes

export interface LatLng {
  lat: number
  lng: number
}

export interface WalkingRoute {
  encodedPolyline: string
  distanceMeters: number
}

export async function computeWalkingRoute(
  apiKey: string,
  origin: LatLng,
  destination: LatLng,
): Promise<WalkingRoute | null> {
  const response = await fetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.polyline.encodedPolyline,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: { latitude: origin.lat, longitude: origin.lng },
          },
        },
        destination: {
          location: {
            latLng: { latitude: destination.lat, longitude: destination.lng },
          },
        },
        travelMode: 'WALK',
      }),
    },
  )

  if (!response.ok) {
    throw new Error(
      `Routes API error: ${response.status} ${await response.text()}`,
    )
  }

  const data = await response.json()
  const route = data.routes?.[0]
  if (!route?.polyline?.encodedPolyline) return null

  return {
    encodedPolyline: route.polyline.encodedPolyline,
    distanceMeters: route.distanceMeters ?? 0,
  }
}
