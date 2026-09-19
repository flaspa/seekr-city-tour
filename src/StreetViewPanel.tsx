import { useEffect, useRef, useState } from 'react'
import { loadStreetViewLibrary } from './googleMaps'

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

// How far to search for a usable panorama if the exact Seekr coordinate
// itself has no Street View coverage.
const PANORAMA_SEARCH_RADIUS_METERS = 200

// Thresholds below which a position/heading update is not "meaningful" and
// should not trigger a new panorama search (Street View panoramas are
// typically spaced ~10-20m apart along a street, so smaller moves almost
// always resolve to the same panorama anyway).
const MIN_POSITION_DELTA_METERS = 30
const MIN_HEADING_DELTA_DEG = 10

type Status = 'loading' | 'ready' | 'unavailable' | 'no-api-key' | 'error'

function haversineMeters(
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

interface StreetViewPanelProps {
  lat: number
  lon: number
  headingDeg: number
  onPanoramaChange?: (panoId: string) => void
}

export default function StreetViewPanel({
  lat,
  lon,
  headingDeg,
  onPanoramaChange,
}: StreetViewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  // Last position/heading actually applied to the panorama, so repeated
  // sub-threshold updates (e.g. throttled ticks during a slow walk) don't
  // each trigger a fresh panorama search.
  const lastAppliedRef = useRef<{
    lat: number
    lon: number
    headingDeg: number
  } | null>(null)

  // A slow-resolving getPanorama() can still be pending when the next
  // eligible position update arrives; without this guard that starts a
  // second, overlapping search. Skipping while one is in flight is safe -
  // the next update that clears the distance/heading threshold will retry.
  const searchInFlightRef = useRef(false)

  const onPanoramaChangeRef = useRef(onPanoramaChange)
  useEffect(() => {
    onPanoramaChangeRef.current = onPanoramaChange
  }, [onPanoramaChange])

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) {
      setStatus('no-api-key')
      return
    }

    const last = lastAppliedRef.current
    const movedMeters = last
      ? haversineMeters(last.lat, last.lon, lat, lon)
      : Infinity
    const turnedDeg = last
      ? Math.abs(((headingDeg - last.headingDeg + 540) % 360) - 180)
      : Infinity

    if (movedMeters < MIN_POSITION_DELTA_METERS) {
      // Position hasn't moved enough to likely need a different panorama -
      // only sync heading (no network request) if it turned meaningfully.
      if (turnedDeg >= MIN_HEADING_DELTA_DEG && panoramaRef.current) {
        panoramaRef.current.setPov({ heading: headingDeg, pitch: 0 })
        lastAppliedRef.current = { lat: last!.lat, lon: last!.lon, headingDeg }
      }
      return
    }

    if (searchInFlightRef.current) {
      // A previous search hasn't resolved yet - don't start an overlapping
      // one. The next update that still clears the threshold will retry.
      return
    }

    let cancelled = false
    searchInFlightRef.current = true
    setStatus('loading')

    loadStreetViewLibrary(GOOGLE_MAPS_API_KEY)
      .then(async ({ StreetViewPanorama, StreetViewService, StreetViewSource }) => {
        if (cancelled || !containerRef.current) return

        if (!panoramaRef.current) {
          panoramaRef.current = new StreetViewPanorama(containerRef.current, {
            addressControl: false,
            fullscreenControl: false,
            motionTracking: false,
            motionTrackingControl: false,
            panControl: false,
            zoomControl: false,
            linksControl: false,
            showRoadLabels: false,
            visible: false,
          })
        }
        const panorama = panoramaRef.current

        try {
          const { data } = await new StreetViewService().getPanorama({
            location: { lat, lng: lon },
            radius: PANORAMA_SEARCH_RADIUS_METERS,
            sources: [StreetViewSource.OUTDOOR],
          })
          if (cancelled) return
          const panoId = data?.location?.pano
          if (!panoId) throw new Error('No panorama in response')

          panorama.setPano(panoId)
          panorama.setPov({ heading: headingDeg, pitch: 0 })
          panorama.setVisible(true)
          lastAppliedRef.current = { lat, lon, headingDeg }
          onPanoramaChangeRef.current?.(panoId)
          setStatus('ready')
        } catch (error) {
          console.warn(
            'No Street View panorama found near this location:',
            error,
          )
          panorama.setVisible(false)
          if (!cancelled) setStatus('unavailable')
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load Google Maps JavaScript API:', error)
        if (!cancelled) setStatus('error')
      })
      .finally(() => {
        searchInFlightRef.current = false
      })

    return () => {
      cancelled = true
    }
  }, [lat, lon, headingDeg])

  return (
    <div className="street-view-panel">
      <div ref={containerRef} className="street-view-canvas" />
      {status === 'no-api-key' && (
        <div className="street-view-message">
          Set VITE_GOOGLE_MAPS_API_KEY to enable Seekr Vision.
        </div>
      )}
      {status === 'unavailable' && (
        <div className="street-view-message">
          No Street View coverage near this location.
        </div>
      )}
      {status === 'error' && (
        <div className="street-view-message">
          Street View failed to load.
        </div>
      )}
    </div>
  )
}
