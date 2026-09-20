# Seekr City Tour

An embodied city-memory demo built with Vite, React, TypeScript, and CesiumJS.

A full-window Cesium 3D view of a selectable city (Los Angeles / Pershing
Square or New York / Times Square) using Google Photorealistic 3D Tiles, with
the Seekr avatar placed in a third-person chase camera. The right-side panel
has a city selector, a Google Street View "Seekr Vision" feed synced to
Seekr's position and facing direction, and placeholders for navigation,
memories, and chat.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

3. Add a Cesium ion access token from https://ion.cesium.com/tokens:

   ```
   VITE_CESIUM_ION_TOKEN=your-token-here
   ```

4. Add a Google Maps API key from https://console.cloud.google.com/google/maps-apis,
   with the **Maps JavaScript API** enabled on that project:

   ```
   VITE_GOOGLE_MAPS_API_KEY=your-key-here
   ```

5. Add a Memories.ai API key (server-side only, do **not** prefix with
   `VITE_`) from https://memories.ai/app/service/key:

   ```
   MEMORIES_API_KEY=your-key-here
   ```

6. Start the memories backend (separate terminal):

   ```bash
   cd server
   npm install
   npm run dev
   ```

7. Start the frontend dev server:

   ```bash
   npm run dev
   ```

The frontend calls the backend at `VITE_MEMORY_API_BASE_URL`
(`http://localhost:8787` by default locally, already set in `.env.example`).

## Stack

- Vite + React + TypeScript
- CesiumJS via `vite-plugin-cesium`
- Google Photorealistic 3D Tiles (loaded through Cesium ion)
- Google Maps JavaScript API (`streetView` library) for the Seekr Vision panel
- `server/` — a tiny Express backend that keeps `MEMORIES_API_KEY` off the
  browser and proxies memory upload/search to Memories.ai

## Deployment

- Frontend: Render **Static Site**, build `npm run build`, publish `dist/`.
  Env var: `VITE_MEMORY_API_BASE_URL` set to the deployed backend's URL
  (plus the existing `VITE_CESIUM_ION_TOKEN` / `VITE_GOOGLE_MAPS_API_KEY`).
- Backend (`server/`): Render **Web Service**, build `npm install`, start
  `npm start`. Env var: `MEMORIES_API_KEY` (server-side only).

## Assets

- `public/assets/models/Seeker.glb` — the Seekr avatar, reused from
  [flaspa/la-ai-navigator](https://github.com/flaspa/la-ai-navigator).
