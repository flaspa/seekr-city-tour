// Loads the Google Maps JavaScript API using Google's current official
// dynamic-library-import bootstrap loader (the inline snippet from
// https://developers.google.com/maps/documentation/javascript/load-maps-js-api),
// then resolves once the "streetView" library is available.

type GoogleMapsNamespace = typeof google.maps & {
  importLibrary: (name: string) => Promise<unknown>
}

// Google's official bootstrap snippet, kept close to the verbatim form Google
// publishes (single-letter names match their docs) so its behavior can be
// diffed against the source rather than trusted to a rewrite.
function injectBootstrapLoader(apiKey: string) {
  ;((g: { key: string; v: string }) => {
    let h: Promise<void> | undefined
    let a: HTMLScriptElement
    const p = 'The Google Maps JavaScript API'
    const c = 'google'
    const l = 'importLibrary'
    const q = '__ib__'
    const m = document
    const win = window as unknown as Record<string, unknown>
    win[c] = win[c] || {}
    const googleNs = win[c] as Record<string, unknown>
    const d = (googleNs.maps as Record<string, unknown>) || (googleNs.maps = {})
    const r = new Set<string>()
    const e = new URLSearchParams()
    const u = (): Promise<void> =>
      h ||
      (h = new Promise<void>((resolve, reject) => {
        a = m.createElement('script')
        e.set('libraries', [...r].join(','))
        for (const k of Object.keys(g) as (keyof typeof g)[]) {
          e.set(
            k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()),
            String(g[k]),
          )
        }
        e.set('callback', c + '.maps.' + q)
        a.src = `https://maps.${c}apis.com/maps/api/js?${e}`
        d[q] = resolve
        a.onerror = () => {
          h = undefined
          reject(new Error(p + ' could not load.'))
        }
        a.nonce =
          (m.querySelector('script[nonce]') as HTMLScriptElement | null)
            ?.nonce ?? ''
        m.head.append(a)
      }))
    if (d[l]) {
      console.warn(p + ' only loads once. Ignoring:', g)
    } else {
      d[l] = (f: string, ...n: unknown[]): Promise<unknown> => {
        r.add(f)
        return u().then(
          () => (d[l] as (...args: unknown[]) => Promise<unknown>)(f, ...n),
        )
      }
    }
  })({ key: apiKey, v: 'weekly' })
}

let bootstrapInjected = false
function ensureBootstrapLoader(apiKey: string) {
  if (bootstrapInjected) return
  bootstrapInjected = true
  injectBootstrapLoader(apiKey)
}

const libraryPromises = new Map<string, Promise<unknown>>()

function loadLibrary<T>(apiKey: string, name: string): Promise<T> {
  ensureBootstrapLoader(apiKey)
  let promise = libraryPromises.get(name)
  if (!promise) {
    promise = (google.maps as GoogleMapsNamespace).importLibrary(name)
    libraryPromises.set(name, promise)
  }
  return promise as Promise<T>
}

export function loadStreetViewLibrary(
  apiKey: string,
): Promise<google.maps.StreetViewLibrary> {
  return loadLibrary(apiKey, 'streetView')
}

export function loadGeocodingLibrary(
  apiKey: string,
): Promise<google.maps.GeocodingLibrary> {
  return loadLibrary(apiKey, 'geocoding')
}

export function loadGeometryLibrary(
  apiKey: string,
): Promise<google.maps.GeometryLibrary> {
  return loadLibrary(apiKey, 'geometry')
}

export function loadCoreLibrary(
  apiKey: string,
): Promise<google.maps.CoreLibrary> {
  return loadLibrary(apiKey, 'core')
}
