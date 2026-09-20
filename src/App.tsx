import { useRef, useState } from 'react'
import './App.css'
import CesiumView, { type LoadingStage, type NavStatus } from './CesiumView'
import StreetViewPanel from './StreetViewPanel'
import {
  CITIES,
  CITY_BY_ID,
  DEFAULT_CITY_ID,
  SEEKR_HEADING_DEG,
  SUGGESTED_DESTINATIONS,
} from './cities'
import {
  describeMemoryImage,
  haversineMeters,
  reverseGeocode,
  searchMemoriesRemotely,
  sendChatMessage,
  storeMemoryRemotely,
  streetViewImageUrl,
  type Memory,
} from './memories'

const SPEED_OPTIONS = [1, 5, 10]
const PERIODIC_CAPTURE_DISTANCE_METERS = 50

const NAV_STATUS_MESSAGE: Record<NavStatus, string> = {
  idle: '',
  geocoding: 'Finding destination…',
  routing: 'Requesting walking route…',
  walking: 'Seekr is walking…',
  arrived: 'Arrived.',
  error: 'Navigation failed.',
}

function App() {
  const [cityId, setCityId] = useState(DEFAULT_CITY_ID)
  const defaultCity = CITY_BY_ID[DEFAULT_CITY_ID]
  const [seekrPosition, setSeekrPosition] = useState({
    lat: defaultCity.latitude,
    lon: defaultCity.longitude,
    headingDeg: SEEKR_HEADING_DEG,
  })

  const [destinationInput, setDestinationInput] = useState('')
  const [navigationRequest, setNavigationRequest] = useState<{
    query: string
  } | null>(null)
  const [navStatus, setNavStatus] = useState<NavStatus>('idle')
  const [navMessage, setNavMessage] = useState('')
  const [speedMultiplier, setSpeedMultiplier] = useState(1)
  const [stopSignal, setStopSignal] = useState(0)
  const [resetSignal, setResetSignal] = useState(0)

  const [loadingStage, setLoadingStage] = useState<LoadingStage>('tiles')
  const [loadingMessage, setLoadingMessage] = useState('Loading 3D city...')

  const [memories, setMemories] = useState<Memory[]>([])
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(
    null,
  )
  const [memorySearchInput, setMemorySearchInput] = useState('')
  const [memorySearchStatus, setMemorySearchStatus] = useState<
    'idle' | 'searching' | 'error'
  >('idle')
  const [memorySearchIds, setMemorySearchIds] = useState<string[] | null>(null)

  interface ChatMessage {
    id: string
    role: 'user' | 'seekr'
    text: string
    memoryId?: string
  }
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatSending, setChatSending] = useState(false)

  // Refs mirror state that capture logic needs to read synchronously
  // (outside React's render/batching timing) at the moment an event fires.
  const seekrPositionRef = useRef(seekrPosition)
  const navStatusRef = useRef(navStatus)
  const currentPanoIdRef = useRef<string | null>(null)
  const lastPeriodicCaptureRef = useRef<{ lat: number; lon: number } | null>(
    null,
  )

  const captureMemory = (reason: Memory['reason']) => {
    // Always Seekr's live position at THIS moment - never the destination
    // input, which may say something entirely different from where Seekr
    // actually is (mid-route, after a manual capture, etc).
    const { lat, lon, headingDeg } = seekrPositionRef.current
    const memory: Memory = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      imageUrl: streetViewImageUrl(lat, lon, headingDeg, currentPanoIdRef.current),
      lat,
      lon,
      headingDeg,
      timestamp: Date.now(),
      city: CITY_BY_ID[cityId].label,
      locationLabel: null,
      locationStatus: 'pending',
      description: null,
      descriptionStatus: 'pending',
      reason,
      memoriesId: null,
      memoriesStatus: 'pending',
      notes: [],
    }
    setMemories((prev) => [memory, ...prev])
    lastPeriodicCaptureRef.current = { lat, lon }

    // Fire-and-forget: local memory already exists and is shown; the
    // Memories.ai identifier attaches asynchronously once upload completes.
    storeMemoryRemotely(memory)
      .then((memoriesId) => {
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, memoriesId, memoriesStatus: 'stored' } : m,
          ),
        )
      })
      .catch((error: unknown) => {
        console.error('Memories.ai store failed:', error)
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, memoriesStatus: 'error' } : m,
          ),
        )
      })

    // Fire-and-forget: reverse-geocode this memory's own capture coordinates
    // into a human-readable label. Never blocks memory creation.
    reverseGeocode(lat, lon)
      .then((locationLabel) => {
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, locationLabel, locationStatus: 'resolved' } : m,
          ),
        )
      })
      .catch((error: unknown) => {
        console.error('Reverse geocoding failed:', error)
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, locationStatus: 'error' } : m,
          ),
        )
      })

    // Fire-and-forget: ask the backend (Claude vision) for a short
    // description of what's visible in the captured image.
    describeMemoryImage(memory.imageUrl)
      .then((description) => {
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, description, descriptionStatus: 'resolved' } : m,
          ),
        )
      })
      .catch((error: unknown) => {
        console.error('Memory image description failed:', error)
        setMemories((prev) =>
          prev.map((m) =>
            m.id === memory.id ? { ...m, descriptionStatus: 'error' } : m,
          ),
        )
      })
  }

  const handleStop = () => {
    setStopSignal((n) => n + 1)
  }

  const handleReset = () => {
    setNavigationRequest(null)
    setDestinationInput('')
    setResetSignal((n) => n + 1)
  }

  const handleMemorySearch = () => {
    const query = memorySearchInput.trim()
    if (!query) {
      setMemorySearchIds(null)
      setMemorySearchStatus('idle')
      return
    }
    setMemorySearchStatus('searching')
    searchMemoriesRemotely(query)
      .then((matches) => {
        setMemorySearchIds(
          matches.map((m) => m.id).filter((id): id is string => Boolean(id)),
        )
        setMemorySearchStatus('idle')
      })
      .catch((error: unknown) => {
        console.error('Memories.ai search failed:', error)
        setMemorySearchStatus('error')
      })
  }

  const handleChatSend = () => {
    const text = chatInput.trim()
    if (!text || chatSending) return
    setChatInput('')

    const userMsgId = `${Date.now()}-u`
    setChatMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }])

    // Associate the message with the current/nearest memory (most recently
    // captured one) - no new memory architecture, just an existing field.
    const currentMemory = memories[0] ?? null
    if (currentMemory) {
      setMemories((prev) =>
        prev.map((m) =>
          m.id === currentMemory.id ? { ...m, notes: [...m.notes, text] } : m,
        ),
      )
    }

    setChatSending(true)
    sendChatMessage(text, currentMemory?.id ?? null, memories)
      .then((reply) => {
        setChatMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-s`,
            role: 'seekr',
            text: reply.answer,
            memoryId: reply.memoryId,
          },
        ])
      })
      .catch((error: unknown) => {
        console.error('Chat failed:', error)
        setChatMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-s`, role: 'seekr', text: 'Sorry, I could not respond.' },
        ])
      })
      .finally(() => setChatSending(false))
  }

  const handleGo = () => {
    if (!destinationInput.trim()) return
    lastPeriodicCaptureRef.current = { ...seekrPositionRef.current }
    setNavigationRequest({ query: destinationInput.trim() })
  }

  const handleSeekrUpdate = (lat: number, lon: number, headingDeg: number) => {
    const next = { lat, lon, headingDeg }
    seekrPositionRef.current = next
    setSeekrPosition(next)

    if (navStatusRef.current === 'walking') {
      const last = lastPeriodicCaptureRef.current
      if (
        !last ||
        haversineMeters(last.lat, last.lon, lat, lon) >=
          PERIODIC_CAPTURE_DISTANCE_METERS
      ) {
        captureMemory('periodic')
      }
    }
  }

  const handleNavigationStatusChange = (
    status: NavStatus,
    message?: string,
  ) => {
    navStatusRef.current = status
    setNavStatus(status)
    setNavMessage(message ?? '')
    if (status === 'arrived') {
      captureMemory('arrival')
    }
  }

  const handleLoadingStageChange = (stage: LoadingStage, message?: string) => {
    setLoadingStage(stage)
    setLoadingMessage(message ?? 'Ready')
  }

  const handleSuggestionClick = (place: string) => {
    setDestinationInput(place)
  }

  const selectedMemory = memories.find((m) => m.id === selectedMemoryId) ?? null
  const visibleMemories = memorySearchIds
    ? memories.filter((m) => m.memoriesId && memorySearchIds.includes(m.memoriesId))
    : memories

  return (
    <div className="app-layout">
      <main className="cesium-panel">
        <CesiumView
          cityId={cityId}
          navigationRequest={navigationRequest}
          speedMultiplier={speedMultiplier}
          stopSignal={stopSignal}
          resetSignal={resetSignal}
          onSeekrUpdate={handleSeekrUpdate}
          onNavigationStatusChange={handleNavigationStatusChange}
          onLoadingStageChange={handleLoadingStageChange}
        />
        {loadingStage !== 'ready' && loadingStage !== 'error' && (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <p className="loading-message">{loadingMessage}</p>
          </div>
        )}
        {loadingStage === 'error' && (
          <div className="loading-banner loading-banner-error">{loadingMessage}</div>
        )}
      </main>
      <aside className="side-panel">
        <h1>Seekr</h1>
        <p>City Tour</p>

        <div className="side-panel-section">
          <label className="city-select-label" htmlFor="city-select">
            City
          </label>
          <select
            id="city-select"
            className="city-select"
            value={cityId}
            onChange={(event) => setCityId(event.target.value)}
          >
            {CITIES.map((city) => (
              <option key={city.id} value={city.id}>
                {city.label}
              </option>
            ))}
          </select>
        </div>

        <div className="side-panel-section">
          <h2>Seekr Vision</h2>
          <StreetViewPanel
            lat={seekrPosition.lat}
            lon={seekrPosition.lon}
            headingDeg={seekrPosition.headingDeg}
            onPanoramaChange={(panoId) => {
              currentPanoIdRef.current = panoId
            }}
          />
        </div>

        <div className="side-panel-section">
          <h2>Navigation</h2>
          <div className="nav-destination-row">
            <input
              type="text"
              className="nav-destination-input"
              placeholder="Type a destination…"
              value={destinationInput}
              onChange={(event) => setDestinationInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleGo()
              }}
            />
            <button
              type="button"
              className="nav-go-button"
              onClick={handleGo}
              disabled={navStatus === 'geocoding' || navStatus === 'routing' || navStatus === 'walking'}
            >
              Go
            </button>
          </div>

          <div className="nav-suggestions-row">
            <label className="nav-suggestions-label" htmlFor="nav-suggestions-select">
              Suggested destinations
            </label>
            <select
              id="nav-suggestions-select"
              className="nav-suggestions-select"
              value=""
              onChange={(event) => {
                if (event.target.value) handleSuggestionClick(event.target.value)
              }}
            >
              <option value="" disabled>
                Choose a suggestion…
              </option>
              {(SUGGESTED_DESTINATIONS[cityId] ?? []).map((place) => (
                <option key={place} value={place}>
                  {place}
                </option>
              ))}
            </select>
          </div>

          <div className="nav-speed-row">
            <span className="nav-speed-label">Speed</span>
            {SPEED_OPTIONS.map((speed) => (
              <button
                key={speed}
                type="button"
                className={
                  'nav-speed-button' +
                  (speedMultiplier === speed ? ' nav-speed-button-active' : '')
                }
                onClick={() => setSpeedMultiplier(speed)}
              >
                {speed}x
              </button>
            ))}
          </div>

          <div className="nav-control-row">
            <button
              type="button"
              className="nav-stop-button"
              onClick={handleStop}
              disabled={
                navStatus !== 'geocoding' &&
                navStatus !== 'routing' &&
                navStatus !== 'walking'
              }
            >
              Stop
            </button>
            <button type="button" className="nav-reset-button" onClick={handleReset}>
              Reset
            </button>
          </div>

          {navStatus !== 'idle' && (
            <p className="nav-status">
              {NAV_STATUS_MESSAGE[navStatus]}
              {navStatus === 'error' && navMessage ? ` (${navMessage})` : ''}
            </p>
          )}
        </div>

        <div className="side-panel-section">
          <h2>Memories</h2>
          <button
            type="button"
            className="memory-capture-button"
            onClick={() => captureMemory('manual')}
          >
            Remember this
          </button>

          <div className="memory-search-row">
            <input
              type="text"
              className="memory-search-input"
              placeholder="Search memories…"
              value={memorySearchInput}
              onChange={(event) => setMemorySearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleMemorySearch()
              }}
            />
            <button
              type="button"
              className="memory-search-button"
              onClick={handleMemorySearch}
              disabled={memorySearchStatus === 'searching'}
            >
              Search
            </button>
          </div>
          {memorySearchStatus === 'error' && (
            <p className="memory-search-status">Search failed.</p>
          )}
          {memorySearchIds && (
            <p className="memory-search-status">
              {visibleMemories.length} matching{' '}
              {visibleMemories.length === 1 ? 'memory' : 'memories'}.{' '}
              <button
                type="button"
                className="memory-search-clear"
                onClick={() => {
                  setMemorySearchInput('')
                  setMemorySearchIds(null)
                }}
              >
                Clear
              </button>
            </p>
          )}

          {selectedMemory && (
            <div className="memory-preview">
              <button
                type="button"
                className="memory-preview-close"
                onClick={() => setSelectedMemoryId(null)}
              >
                ×
              </button>
              <img
                className="memory-preview-image"
                src={selectedMemory.imageUrl}
                alt={selectedMemory.locationLabel ?? 'Seekr memory'}
              />
              <p className="memory-preview-label">
                {selectedMemory.locationStatus === 'pending'
                  ? 'Locating…'
                  : selectedMemory.locationLabel ?? selectedMemory.city}
              </p>
              {selectedMemory.description && (
                <p className="memory-preview-description">{selectedMemory.description}</p>
              )}
              <p className="memory-preview-meta">
                {new Date(selectedMemory.timestamp).toLocaleTimeString()} ·{' '}
                {selectedMemory.lat.toFixed(4)}, {selectedMemory.lon.toFixed(4)}
              </p>
              <p className="memory-preview-meta">
                Memories.ai:{' '}
                {selectedMemory.memoriesStatus === 'stored'
                  ? `stored (${selectedMemory.memoriesId})`
                  : selectedMemory.memoriesStatus === 'error'
                    ? 'not stored (error)'
                    : 'storing…'}
              </p>
            </div>
          )}

          {visibleMemories.length === 0 ? (
            <p>
              {memorySearchIds
                ? 'No matching memories.'
                : 'No memories captured yet.'}
            </p>
          ) : (
            <div className="memory-grid">
              {visibleMemories.map((memory) => (
                <button
                  key={memory.id}
                  type="button"
                  className="memory-thumb-button"
                  onClick={() => setSelectedMemoryId(memory.id)}
                >
                  <img
                    className="memory-thumb-image"
                    src={memory.imageUrl}
                    alt={memory.locationLabel ?? 'Seekr memory'}
                  />
                  <span className="memory-thumb-label">
                    {memory.locationStatus === 'pending'
                      ? 'Locating…'
                      : memory.locationLabel ?? memory.city}
                  </span>
                  {memory.description && (
                    <span className="memory-thumb-description">{memory.description}</span>
                  )}
                  <span className="memory-thumb-time">
                    {new Date(memory.timestamp).toLocaleTimeString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="side-panel-section">
          <h2>Chat</h2>
          <div className="chat-history">
            {chatMessages.length === 0 ? (
              <p>Ask Seekr about the trip.</p>
            ) : (
              chatMessages.map((msg) => {
                const memory = msg.memoryId
                  ? memories.find((m) => m.id === msg.memoryId)
                  : null
                return (
                  <div key={msg.id} className={`chat-message chat-message-${msg.role}`}>
                    <p className="chat-message-text">{msg.text}</p>
                    {memory && (
                      <img
                        className="chat-message-image"
                        src={memory.imageUrl}
                        alt={memory.locationLabel ?? 'Seekr memory'}
                      />
                    )}
                  </div>
                )
              })
            )}
          </div>
          <div className="chat-input-row">
            <input
              type="text"
              className="chat-input"
              placeholder="Message Seekr…"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleChatSend()
              }}
            />
            <button
              type="button"
              className="chat-send-button"
              onClick={handleChatSend}
              disabled={chatSending}
            >
              Send
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

export default App
