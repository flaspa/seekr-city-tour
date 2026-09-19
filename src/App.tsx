import { useState } from 'react'
import './App.css'
import CesiumView from './CesiumView'
import { CITIES, DEFAULT_CITY_ID } from './cities'

function App() {
  const [cityId, setCityId] = useState(DEFAULT_CITY_ID)

  return (
    <div className="app-layout">
      <main className="cesium-panel">
        <CesiumView cityId={cityId} />
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
          <p>Street View feed coming soon.</p>
        </div>
        <div className="side-panel-section">
          <h2>Navigation</h2>
          <p>Controls coming soon.</p>
        </div>
        <div className="side-panel-section">
          <h2>Memories</h2>
          <p>Captured memories coming soon.</p>
        </div>
        <div className="side-panel-section">
          <h2>Chat</h2>
          <p>Conversational recall coming soon.</p>
        </div>
      </aside>
    </div>
  )
}

export default App
