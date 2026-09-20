export interface CityConfig {
  id: string
  label: string
  longitude: number
  latitude: number
}

export const CITIES: CityConfig[] = [
  {
    id: 'nyc',
    label: 'New York — Times Square',
    longitude: -73.9855,
    latitude: 40.758,
  },
  {
    id: 'la',
    label: 'Los Angeles — Pershing Square',
    longitude: -118.2531,
    latitude: 34.0482,
  },
]

export const DEFAULT_CITY_ID = 'nyc'

// Compass bearing Seekr faces at any city. Shared by the Cesium chase camera
// and the Street View panel so both stay pointed the same direction.
export const SEEKR_HEADING_DEG = 200

export const CITY_BY_ID: Record<string, CityConfig> = Object.fromEntries(
  CITIES.map((city) => [city.id, city]),
)

// Small static list of nearby demo destinations per city, shown in the
// suggested-destinations dropdown under the destination input.
export const SUGGESTED_DESTINATIONS: Record<string, string[]> = {
  nyc: [
    'Rockefeller Center',
    'Bryant Park',
    'Radio City Music Hall',
    'Grand Central Terminal',
    'Central Park South',
  ],
  la: [
    'Grand Central Market',
    'The Last Bookstore',
    'The Broad',
    'Walt Disney Concert Hall',
    'Los Angeles City Hall',
  ],
}
