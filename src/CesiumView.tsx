import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { CITY_BY_ID, type CityConfig } from './cities'

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as
  | string
  | undefined

const FALLBACK_GROUND_HEIGHT = 90 // used only if tileset height sampling fails

const SEEKR_MODEL_URL = '/assets/models/Seeker.glb'
const SEEKR_SCALE = 4
const SEEKR_HEADING_DEG = 200 // compass bearing Seekr faces

// Cesium orients a glTF model's forward axis along +X, and a heading of 0 in
// headingPitchRollToFixedFrame points +X east - but compass headings are
// 0 = north, so the model needs a -90 degree base correction. (Calibrated
// against this same Seeker.glb asset in Min's la-ai-navigator reference.)
const MODEL_YAW_CORRECTION_DEG = -90

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

// Samples the tileset's surface height at the city's coordinates and returns
// a ground-clamped world position for Seekr.
async function computeGroundedPosition(
  viewer: Cesium.Viewer,
  city: CityConfig,
): Promise<Cesium.Cartesian3> {
  const groundPosition = Cesium.Cartographic.fromDegrees(
    city.longitude,
    city.latitude,
  )
  if (viewer.scene.sampleHeightSupported) {
    try {
      await viewer.scene.sampleHeightMostDetailed([groundPosition])
    } catch (error) {
      console.warn(
        'Ground height sampling failed, using fallback height:',
        error,
      )
    }
  }
  const groundHeight = Number.isFinite(groundPosition.height)
    ? groundPosition.height
    : FALLBACK_GROUND_HEIGHT
  return Cesium.Cartesian3.fromRadians(
    groundPosition.longitude,
    groundPosition.latitude,
    groundHeight,
  )
}

// Third-person chase camera: lock the view on Seekr, framed by the model's
// own bounding sphere so the character stays clearly visible without the
// camera pressing into the photogrammetry. Cesium's default mouse controls
// remain active and orbit/zoom around this look-at point.
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

interface CesiumViewProps {
  cityId: string
}

export default function CesiumView({ cityId }: CesiumViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const tilesetRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const seekrModelRef = useRef<Cesium.Model | null>(null)

  // Always readable synchronously from async callbacks, so a city switch
  // mid-load is picked up by whichever load step reads it next.
  const cityIdRef = useRef(cityId)
  useEffect(() => {
    cityIdRef.current = cityId
  }, [cityId])

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
      shouldAnimate: true, // required for Seekr's Idle animation to play
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

          const position = await computeGroundedPosition(
            viewer,
            CITY_BY_ID[cityIdRef.current],
          )
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

    let cancelled = false
    const city = CITY_BY_ID[cityId]
    setEstablishingView(viewer, city)
    ;(async () => {
      const position = await computeGroundedPosition(viewer, city)
      if (cancelled) return
      model.modelMatrix = seekrModelMatrix(position, SEEKR_HEADING_DEG)
      await waitOneFrame(viewer)
      if (cancelled) return
      frameChaseCamera(viewer, model)
    })()

    return () => {
      cancelled = true
    }
  }, [cityId])

  return <div ref={containerRef} className="cesium-view" />
}
