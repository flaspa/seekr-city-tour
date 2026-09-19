import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { CITY_BY_ID, SEEKR_HEADING_DEG, type CityConfig } from './cities'
import {
  loadCoreLibrary,
  loadGeocodingLibrary,
  loadGeometryLibrary,
} from './googleMaps'
import { computeWalkingRoute } from './routing'

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as
  | string
  | undefined
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

const FALLBACK_GROUND_HEIGHT = 90 // used only if tileset height sampling fails

const SEEKR_MODEL_URL = '/assets/models/Seeker.glb'
const SEEKR_SCALE = 4
const BASE_WALK_SPEED_MPS = 1.4 // average human walking pace

// Cesium orients a glTF model's forward axis along +X, and a heading of 0 in
// headingPitchRollToFixedFrame points +X east - but compass headings are
// 0 = north, so the model needs a -90 degree base correction. (Calibrated
// against this same Seeker.glb asset in Min's la-ai-navigator reference.)
const MODEL_YAW_CORRECTION_DEG = -90

export type NavStatus =
  | 'idle'
  | 'geocoding'
  | 'routing'
  | 'walking'
  | 'arrived'
  | 'error'

interface RoutePoint {
  lon: number
  lat: number
}

function seekrModelMatrix(position: Cesium.Cartesian3, headingDeg: number) {
  return Cesium.Transforms.headingPitchRollToFixedFrame(
    position,
    new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(headingDeg + MODEL_YAW_CORRECTION_DEG),
      0,
      0,
    ),
  )
}

// Initial great-circle compass bearing from point 1 to point 2, in degrees.
function computeBearingDeg(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const phi1 = Cesium.Math.toRadians(lat1)
  const phi2 = Cesium.Math.toRadians(lat2)
  const deltaLambda = Cesium.Math.toRadians(lon2 - lon1)
  const y = Math.sin(deltaLambda) * Math.cos(phi2)
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda)
  return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360
}

// Establishing view over the city while the tileset/model settle at the new
// location. Reused for both the initial load and later city switches.
function setEstablishingView(viewer: Cesium.Viewer, city: CityConfig) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      city.longitude,
      city.latitude,
      450,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(20),
      pitch: Cesium.Math.toRadians(-25),
      roll: 0,
    },
  })
}

async function sampleGroundHeight(
  viewer: Cesium.Viewer,
  lon: number,
  lat: number,
): Promise<number> {
  const cartographic = Cesium.Cartographic.fromDegrees(lon, lat)
  if (viewer.scene.sampleHeightSupported) {
    try {
      await viewer.scene.sampleHeightMostDetailed([cartographic])
    } catch (error) {
      console.warn('Ground height sampling failed:', error)
    }
  }
  return Number.isFinite(cartographic.height)
    ? cartographic.height
    : FALLBACK_GROUND_HEIGHT
}

async function computeGroundedPosition(
  viewer: Cesium.Viewer,
  city: CityConfig,
): Promise<Cesium.Cartesian3> {
  const height = await sampleGroundHeight(viewer, city.longitude, city.latitude)
  return Cesium.Cartesian3.fromDegrees(city.longitude, city.latitude, height)
}

// Third-person chase camera: lock the view on Seekr, framed by the model's
// own bounding sphere so the character stays clearly visible without the
// camera pressing into the photogrammetry.
function frameChaseCamera(viewer: Cesium.Viewer, model: Cesium.Model) {
  const radius = model.boundingSphere.radius
  viewer.camera.lookAt(
    model.boundingSphere.center,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(SEEKR_HEADING_DEG + 180),
      Cesium.Math.toRadians(-15),
      radius * 5,
    ),
  )
}

// A primitive's boundingSphere reflects a new modelMatrix only after the
// next render pass, so repositioning an already-loaded model needs to wait
// a frame before the chase camera reads an up-to-date center.
function waitOneFrame(viewer: Cesium.Viewer): Promise<void> {
  return new Promise((resolve) => {
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove()
      resolve()
    })
  })
}

// Walks Seekr along `path` at a constant, deterministic pace, updating its
// position/heading, the Idle/Walk animation, and the chase camera every
// frame. Resolves once the destination is reached or the walk is cancelled.
function walkRoute(
  viewer: Cesium.Viewer,
  model: Cesium.Model,
  path: RoutePoint[],
  speedMultiplierRef: { current: number },
  abortState: { cancelled: boolean },
  onTick: (lon: number, lat: number, headingDeg: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const cartesianPoints = path.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    )
    const segmentLengths: number[] = []
    for (let i = 1; i < cartesianPoints.length; i++) {
      segmentLengths.push(
        Cesium.Cartesian3.distance(cartesianPoints[i - 1], cartesianPoints[i]),
      )
    }
    const totalDistance = segmentLengths.reduce((a, b) => a + b, 0)

    const startTranslation = Cesium.Matrix4.getTranslation(
      model.modelMatrix,
      new Cesium.Cartesian3(),
    )
    let currentHeight = Cesium.Cartographic.fromCartesian(
      startTranslation,
    ).height

    let traveled = 0
    let lastTime = performance.now()
    let heightSampleInFlight = false

    // As Seekr's tight chase camera continuously reveals fresh ground ahead,
    // sampleHeightMostDetailed sometimes resolves against a coarser,
    // not-yet-refined 3D Tile (a bounding proxy that encloses the real
    // street geometry from above) before the leaf-level tile finishes
    // streaming in, then snaps back down once it does. That error is
    // one-directional - always high, never below the true surface - so a
    // short rolling minimum recovers the real ground height and rides out
    // the transient highs without needing to guess which sample is "right".
    const HEIGHT_SAMPLE_WINDOW = 8
    let recentHeights: number[] = []

    // sampleHeightMostDetailed forces the actual tileset geometry to be
    // used regardless of what the tight chase camera currently has
    // on-screen (unlike the synchronous Scene.sampleHeight/clampToHeight,
    // which only intersect whatever is already rendered in view and can
    // pick up unrelated geometry - e.g. a nearby building - for a fast,
    // narrowly-framed moving target). Only one request is kept in flight;
    // the next one fires for wherever Seekr currently is as soon as it
    // resolves, so sampling adapts to how fast tiles actually load instead
    // of lagging behind a fixed timer.
    function requestHeightSample(lon: number, lat: number) {
      if (heightSampleInFlight || !viewer.scene.sampleHeightSupported) return
      heightSampleInFlight = true
      const cartographic = Cesium.Cartographic.fromDegrees(lon, lat)
      viewer.scene
        .sampleHeightMostDetailed([cartographic])
        .then(() => {
          heightSampleInFlight = false
          if (abortState.cancelled || !Number.isFinite(cartographic.height)) {
            return
          }
          recentHeights.push(cartographic.height)
          if (recentHeights.length > HEIGHT_SAMPLE_WINDOW) {
            recentHeights.shift()
          }
          currentHeight = Math.min(...recentHeights)
        })
        .catch(() => {
          heightSampleInFlight = false
        })
    }

    let animName: string | null = null
    let animMultiplier = 1
    function setAnim(name: string, multiplier = 1) {
      if (animName === name && Math.abs(animMultiplier - multiplier) < 0.3) {
        return
      }
      try {
        model.activeAnimations.removeAll()
        model.activeAnimations.add({
          name,
          loop: Cesium.ModelAnimationLoop.REPEAT,
          multiplier: Math.max(0.2, multiplier),
        })
        animName = name
        animMultiplier = multiplier
      } catch {
        // clip name missing in the glb - ignore
      }
    }

    const remove = viewer.scene.postUpdate.addEventListener(() => {
      if (abortState.cancelled) {
        remove()
        resolve()
        return
      }

      const now = performance.now()
      const dt = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now
      traveled += BASE_WALK_SPEED_MPS * speedMultiplierRef.current * dt

      if (traveled >= totalDistance) {
        const last = path[path.length - 1]
        const prev = path[path.length - 2]
        const headingDeg = computeBearingDeg(
          prev.lon,
          prev.lat,
          last.lon,
          last.lat,
        )
        model.modelMatrix = seekrModelMatrix(
          Cesium.Cartesian3.fromDegrees(last.lon, last.lat, currentHeight),
          headingDeg,
        )
        setAnim('Idle')
        frameChaseCamera(viewer, model)
        onTick(last.lon, last.lat, headingDeg)
        remove()
        resolve()
        return
      }

      let segIndex = 0
      let distIntoSeg = traveled
      while (
        distIntoSeg > segmentLengths[segIndex] &&
        segIndex < segmentLengths.length - 1
      ) {
        distIntoSeg -= segmentLengths[segIndex]
        segIndex++
      }
      const segLen = segmentLengths[segIndex] || 1
      const f = Math.min(1, distIntoSeg / segLen)
      const p0 = path[segIndex]
      const p1 = path[segIndex + 1]
      const lon = p0.lon + (p1.lon - p0.lon) * f
      const lat = p0.lat + (p1.lat - p0.lat) * f
      const headingDeg = computeBearingDeg(p0.lon, p0.lat, p1.lon, p1.lat)

      requestHeightSample(lon, lat)

      model.modelMatrix = seekrModelMatrix(
        Cesium.Cartesian3.fromDegrees(lon, lat, currentHeight),
        headingDeg,
      )
      setAnim('Walk', speedMultiplierRef.current)
      frameChaseCamera(viewer, model)
      onTick(lon, lat, headingDeg)
    })
  })
}

interface CesiumViewProps {
  cityId: string
  navigationRequest: { query: string } | null
  speedMultiplier: number
  onSeekrUpdate: (lat: number, lon: number, headingDeg: number) => void
  onNavigationStatusChange: (status: NavStatus, message?: string) => void
}

export default function CesiumView({
  cityId,
  navigationRequest,
  speedMultiplier,
  onSeekrUpdate,
  onNavigationStatusChange,
}: CesiumViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const tilesetRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const seekrModelRef = useRef<Cesium.Model | null>(null)

  // Seekr's live geographic position/heading - the route origin for the next
  // "Go", and what drives the throttled Street View sync during a walk.
  const currentPositionRef = useRef<RoutePoint>({ lon: 0, lat: 0 })
  const activeWalkAbortRef = useRef<{ cancelled: boolean } | null>(null)

  // Always readable synchronously from async callbacks/loops, so the latest
  // prop value is used even mid-flight.
  const cityIdRef = useRef(cityId)
  useEffect(() => {
    cityIdRef.current = cityId
  }, [cityId])
  const speedMultiplierRef = useRef(speedMultiplier)
  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier
  }, [speedMultiplier])
  const onSeekrUpdateRef = useRef(onSeekrUpdate)
  useEffect(() => {
    onSeekrUpdateRef.current = onSeekrUpdate
  }, [onSeekrUpdate])
  const onNavigationStatusRef = useRef(onNavigationStatusChange)
  useEffect(() => {
    onNavigationStatusRef.current = onNavigationStatusChange
  }, [onNavigationStatusChange])

  // One-time setup: create the Viewer and load the tileset + Seekr model.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    if (CESIUM_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN
    } else {
      console.warn(
        'No Cesium ion token found. Set VITE_CESIUM_ION_TOKEN in a .env file to load Google Photorealistic 3D Tiles.',
      )
    }

    const viewer = new Cesium.Viewer(containerRef.current, {
      // The photorealistic tileset supplies its own ground surface, so skip
      // creating a default Globe + Ion world imagery layer altogether.
      globe: false,
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      timeline: false,
      animation: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true, // required for Seekr's animations to play
    })
    viewerRef.current = viewer

    let cancelled = false

    // React StrictMode double-invokes this effect in dev (mount -> cleanup ->
    // mount, synchronously). Deferring the tileset request lets the throwaway
    // first mount's cleanup cancel it via clearTimeout before it ever fires,
    // so only the real mount hits Google's rate-limited tile endpoint.
    const startTilesetLoad = window.setTimeout(() => {
      setEstablishingView(viewer, CITY_BY_ID[cityIdRef.current])

      Cesium.createGooglePhotorealistic3DTileset({
        onlyUsingWithGoogleGeocoder: true,
      })
        .then(async (result) => {
          if (cancelled) return
          tilesetRef.current = result
          viewer.scene.primitives.add(result)

          const city = CITY_BY_ID[cityIdRef.current]
          const position = await computeGroundedPosition(viewer, city)
          if (cancelled) return

          const model = await Cesium.Model.fromGltfAsync({
            url: SEEKR_MODEL_URL,
            scale: SEEKR_SCALE,
            modelMatrix: seekrModelMatrix(position, SEEKR_HEADING_DEG),
          })
          if (cancelled) {
            model.destroy()
            return
          }
          seekrModelRef.current = model
          viewer.scene.primitives.add(model)
          currentPositionRef.current = { lon: city.longitude, lat: city.latitude }
          onSeekrUpdateRef.current(city.latitude, city.longitude, SEEKR_HEADING_DEG)

          model.readyEvent.addEventListener((readyModel: Cesium.Model) => {
            try {
              readyModel.activeAnimations.add({
                name: 'Idle',
                loop: Cesium.ModelAnimationLoop.REPEAT,
              })
            } catch (error) {
              console.warn('Seekr idle animation unavailable:', error)
            }
            frameChaseCamera(viewer, readyModel)
          })
        })
        .catch((error: unknown) => {
          console.error(
            'Failed to load Google Photorealistic 3D Tiles:',
            error,
          )
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(startTilesetLoad)
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      if (seekrModelRef.current && !seekrModelRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(seekrModelRef.current)
      }
      if (tilesetRef.current) {
        viewer.scene.primitives.remove(tilesetRef.current)
      }
      if (!viewer.isDestroyed()) {
        viewer.destroy()
      }
      viewerRef.current = null
      tilesetRef.current = null
      seekrModelRef.current = null
    }
  }, [])

  // City switch: move the existing Seekr model and chase camera to the
  // newly selected city, reusing the same viewer and tileset. A no-op while
  // the initial load above hasn't finished yet (it places Seekr at
  // cityIdRef.current itself once ready).
  useEffect(() => {
    const viewer = viewerRef.current
    const tileset = tilesetRef.current
    const model = seekrModelRef.current
    if (!viewer || !tileset || !model) return

    if (activeWalkAbortRef.current) activeWalkAbortRef.current.cancelled = true

    let cancelled = false
    const city = CITY_BY_ID[cityId]
    setEstablishingView(viewer, city)
    ;(async () => {
      const position = await computeGroundedPosition(viewer, city)
      if (cancelled) return
      model.modelMatrix = seekrModelMatrix(position, SEEKR_HEADING_DEG)
      currentPositionRef.current = { lon: city.longitude, lat: city.latitude }
      onSeekrUpdateRef.current(city.latitude, city.longitude, SEEKR_HEADING_DEG)
      await waitOneFrame(viewer)
      if (cancelled) return
      frameChaseCamera(viewer, model)
    })()

    return () => {
      cancelled = true
    }
  }, [cityId])

  // Destination navigation: geocode the query, request a walking route from
  // Seekr's current position, and walk it deterministically.
  useEffect(() => {
    if (!navigationRequest) return
    const viewer = viewerRef.current
    const model = seekrModelRef.current
    if (!viewer || !model) {
      onNavigationStatusRef.current(
        'error',
        'Scene is still loading - try again in a moment.',
      )
      return
    }
    if (!GOOGLE_MAPS_API_KEY) {
      onNavigationStatusRef.current(
        'error',
        'Missing VITE_GOOGLE_MAPS_API_KEY.',
      )
      return
    }

    if (activeWalkAbortRef.current) activeWalkAbortRef.current.cancelled = true
    const abortState = { cancelled: false }
    activeWalkAbortRef.current = abortState

    ;(async () => {
      try {
        onNavigationStatusRef.current('geocoding')
        const city = CITY_BY_ID[cityIdRef.current]
        const [{ Geocoder }, { LatLngBounds }] = await Promise.all([
          loadGeocodingLibrary(GOOGLE_MAPS_API_KEY),
          loadCoreLibrary(GOOGLE_MAPS_API_KEY),
        ])
        if (abortState.cancelled) return

        const bounds = new LatLngBounds(
          { lat: city.latitude - 0.15, lng: city.longitude - 0.15 },
          { lat: city.latitude + 0.15, lng: city.longitude + 0.15 },
        )
        const geocodeResponse = await new Geocoder().geocode({
          address: navigationRequest.query,
          bounds,
        })
        if (abortState.cancelled) return
        const target = geocodeResponse.results[0]
        if (!target) throw new Error('Destination not found')
        const destination = {
          lat: target.geometry.location.lat(),
          lng: target.geometry.location.lng(),
        }

        onNavigationStatusRef.current('routing')
        const origin = currentPositionRef.current
        const route = await computeWalkingRoute(
          GOOGLE_MAPS_API_KEY,
          { lat: origin.lat, lng: origin.lon },
          destination,
        )
        if (abortState.cancelled) return
        if (!route) throw new Error('No walking route found')

        const { encoding } = await loadGeometryLibrary(GOOGLE_MAPS_API_KEY)
        if (abortState.cancelled) return
        const path: RoutePoint[] = encoding
          .decodePath(route.encodedPolyline)
          .map((p) => ({ lon: p.lng(), lat: p.lat() }))
        if (path.length < 2) throw new Error('Route has no walkable geometry')

        onNavigationStatusRef.current('walking')
        viewer.scene.screenSpaceCameraController.enableInputs = false

        let lastEmit = 0
        await walkRoute(
          viewer,
          model,
          path,
          speedMultiplierRef,
          abortState,
          (lon, lat, headingDeg) => {
            currentPositionRef.current = { lon, lat }
            const now = performance.now()
            // Throttled well below Street View's request rate limit - each
            // sync triggers several panorama sub-requests internally.
            if (now - lastEmit > 2500) {
              lastEmit = now
              onSeekrUpdateRef.current(lat, lon, headingDeg)
            }
          },
        )

        viewer.scene.screenSpaceCameraController.enableInputs = true
        if (!abortState.cancelled) {
          const finalPos = currentPositionRef.current
          onSeekrUpdateRef.current(finalPos.lat, finalPos.lon, SEEKR_HEADING_DEG)
          onNavigationStatusRef.current('arrived')
        }
      } catch (error) {
        viewer.scene.screenSpaceCameraController.enableInputs = true
        console.error('Navigation failed:', error)
        if (!abortState.cancelled) {
          onNavigationStatusRef.current(
            'error',
            error instanceof Error ? error.message : 'Navigation failed.',
          )
        }
      }
    })()

    return () => {
      abortState.cancelled = true
    }
  }, [navigationRequest])

  return <div ref={containerRef} className="cesium-view" />
}
