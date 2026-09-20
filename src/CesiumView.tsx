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

export type LoadingStage = 'city' | 'tiles' | 'seekr' | 'ready' | 'error'

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

// createGooglePhotorealistic3DTileset() resolving only means the tileset's
// root metadata is usable - it says nothing about whether the tiles for the
// CURRENT camera view have actually streamed in and rendered yet. tilesLoaded
// is the live signal for that: true once every tile the current view needs
// is loaded. Require two consecutive true frames (matches the documented
// CesiumJS pattern for this) so a single stale/in-between frame doesn't
// report ready too early. Resolves false on timeout or cancellation.
function waitForTilesetView(
  viewer: Cesium.Viewer,
  tileset: Cesium.Cesium3DTileset,
  isCancelled: () => boolean,
  timeoutMs = 20000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let readyFrames = 0
    const remove = viewer.scene.postRender.addEventListener(() => {
      if (isCancelled()) {
        window.clearTimeout(timeoutId)
        remove()
        resolve(false)
        return
      }
      readyFrames = tileset.tilesLoaded ? readyFrames + 1 : 0
      if (readyFrames < 2) return
      window.clearTimeout(timeoutId)
      remove()
      resolve(true)
    })
    const timeoutId = window.setTimeout(() => {
      remove()
      resolve(false)
    }, timeoutMs)
  })
}

interface GroundedWaypoint {
  lon: number
  lat: number
  height: number
}

// Every original route vertex (turn) is kept exactly, with intermediate
// points inserted along long segments so no gap exceeds ~10-20m.
const ROUTE_WAYPOINT_STEP_METERS = 15

function resampleRoutePoints(path: RoutePoint[]): RoutePoint[] {
  const result: RoutePoint[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const p0 = path[i - 1]
    const p1 = path[i]
    const segLen = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(p0.lon, p0.lat),
      Cesium.Cartesian3.fromDegrees(p1.lon, p1.lat),
    )
    const steps = Math.max(1, Math.round(segLen / ROUTE_WAYPOINT_STEP_METERS))
    for (let s = 1; s <= steps; s++) {
      const f = s / steps
      result.push({
        lon: p0.lon + (p1.lon - p0.lon) * f,
        lat: p0.lat + (p1.lat - p0.lat) * f,
      })
    }
  }
  return result
}

// Ground every route waypoint ONCE, before Seekr starts walking - adapted
// from Min's la-ai-navigator waypoint-height approach (sample per waypoint
// up front, then just interpolate lat/lon/height while walking) rather than
// resampling continuously during motion.
async function buildGroundedWaypoints(
  viewer: Cesium.Viewer,
  path: RoutePoint[],
): Promise<GroundedWaypoint[]> {
  const points = resampleRoutePoints(path)
  const cartographics = points.map((p) =>
    Cesium.Cartographic.fromDegrees(p.lon, p.lat),
  )

  if (viewer.scene.sampleHeightSupported) {
    try {
      await viewer.scene.sampleHeightMostDetailed(cartographics)
    } catch (error) {
      console.warn('Route waypoint height sampling failed:', error)
    }
  }

  const heights: (number | undefined)[] = cartographics.map((c) =>
    Number.isFinite(c.height) ? c.height : undefined,
  )
  // A waypoint whose sample failed borrows the nearest neighbor's height
  // instead of falling back to a continuous runtime sampler.
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] !== undefined) continue
    let before = -1
    for (let j = i - 1; j >= 0; j--) {
      if (heights[j] !== undefined) {
        before = j
        break
      }
    }
    let after = -1
    for (let j = i + 1; j < heights.length; j++) {
      if (heights[j] !== undefined) {
        after = j
        break
      }
    }
    if (before !== -1 && after !== -1) {
      heights[i] = i - before <= after - i ? heights[before] : heights[after]
    } else if (before !== -1) {
      heights[i] = heights[before]
    } else if (after !== -1) {
      heights[i] = heights[after]
    } else {
      heights[i] = FALLBACK_GROUND_HEIGHT
    }
  }

  return points.map((p, i) => ({ lon: p.lon, lat: p.lat, height: heights[i]! }))
}

// Walks Seekr along already-grounded `waypoints` at a constant, deterministic
// pace, interpolating position/height/heading, the Idle/Walk animation, and
// the chase camera every frame. No height sampling happens during this loop -
// every waypoint's height was already resolved by buildGroundedWaypoints.
// Resolves once the destination is reached or the walk is cancelled.
function walkRoute(
  viewer: Cesium.Viewer,
  model: Cesium.Model,
  waypoints: GroundedWaypoint[],
  speedMultiplierRef: { current: number },
  abortState: { cancelled: boolean },
  onTick: (lon: number, lat: number, headingDeg: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const cartesianPoints = waypoints.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    )
    const segmentLengths: number[] = []
    for (let i = 1; i < cartesianPoints.length; i++) {
      segmentLengths.push(
        Cesium.Cartesian3.distance(cartesianPoints[i - 1], cartesianPoints[i]),
      )
    }
    const totalDistance = segmentLengths.reduce((a, b) => a + b, 0)

    let traveled = 0
    let lastTime = performance.now()

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
        const last = waypoints[waypoints.length - 1]
        const prev = waypoints[waypoints.length - 2]
        const headingDeg = computeBearingDeg(
          prev.lon,
          prev.lat,
          last.lon,
          last.lat,
        )
        model.modelMatrix = seekrModelMatrix(
          Cesium.Cartesian3.fromDegrees(last.lon, last.lat, last.height),
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
      const p0 = waypoints[segIndex]
      const p1 = waypoints[segIndex + 1]
      const lon = p0.lon + (p1.lon - p0.lon) * f
      const lat = p0.lat + (p1.lat - p0.lat) * f
      const height = p0.height + (p1.height - p0.height) * f
      const headingDeg = computeBearingDeg(p0.lon, p0.lat, p1.lon, p1.lat)

      model.modelMatrix = seekrModelMatrix(
        Cesium.Cartesian3.fromDegrees(lon, lat, height),
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
  onLoadingStageChange: (stage: LoadingStage, message?: string) => void
}

export default function CesiumView({
  cityId,
  navigationRequest,
  speedMultiplier,
  onSeekrUpdate,
  onNavigationStatusChange,
  onLoadingStageChange,
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
  const onLoadingStageRef = useRef(onLoadingStageChange)
  useEffect(() => {
    onLoadingStageRef.current = onLoadingStageChange
  }, [onLoadingStageChange])

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
    onLoadingStageRef.current('tiles', `Loading ${CITY_BY_ID[cityIdRef.current].label}...`)

    const startTilesetLoad = window.setTimeout(() => {
      setEstablishingView(viewer, CITY_BY_ID[cityIdRef.current])

      Cesium.createGooglePhotorealistic3DTileset({
        onlyUsingWithGoogleGeocoder: true,
      })
        .then(async (result) => {
          if (cancelled) return
          tilesetRef.current = result
          viewer.scene.primitives.add(result)
          onLoadingStageRef.current('seekr', 'Loading Seekr...')

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
            waitForTilesetView(viewer, result, () => cancelled).then((loaded) => {
              if (cancelled) return
              if (loaded) {
                onLoadingStageRef.current('ready')
              } else {
                onLoadingStageRef.current(
                  'error',
                  'City tiles took too long to load.',
                )
              }
            })
          })
        })
        .catch((error: unknown) => {
          console.error(
            'Failed to load Google Photorealistic 3D Tiles:',
            error,
          )
          onLoadingStageRef.current('error', 'City failed to load.')
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
    onLoadingStageRef.current('city', `Loading ${city.label}...`)
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
      const loaded = await waitForTilesetView(viewer, tileset, () => cancelled)
      if (cancelled) return
      if (loaded) {
        onLoadingStageRef.current('ready')
      } else {
        onLoadingStageRef.current('error', 'City tiles took too long to load.')
      }
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

        // Ground every route waypoint once, up front, before any animation
        // starts - no height sampling happens during the walk itself.
        const waypoints = await buildGroundedWaypoints(viewer, path)
        if (abortState.cancelled) return

        onNavigationStatusRef.current('walking')
        viewer.scene.screenSpaceCameraController.enableInputs = false

        let lastEmit = 0
        await walkRoute(
          viewer,
          model,
          waypoints,
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
