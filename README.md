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

5. Start the dev server:

   ```bash
   npm run dev
   ```

## Stack

- Vite + React + TypeScript
- CesiumJS via `vite-plugin-cesium`
- Google Photorealistic 3D Tiles (loaded through Cesium ion)
- Google Maps JavaScript API (`streetView` library) for the Seekr Vision panel

## Assets

- `public/assets/models/Seeker.glb` — the Seekr avatar, reused from
  [flaspa/la-ai-navigator](https://github.com/flaspa/la-ai-navigator).
