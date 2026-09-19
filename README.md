# Seekr City Tour

An embodied city-memory demo built with Vite, React, TypeScript, and CesiumJS.

This is the initial foundation: a full-window Cesium 3D view of Downtown Los
Angeles using Google Photorealistic 3D Tiles, with the Seekr avatar placed
in a third-person chase camera, and a right-side panel reserved for future
Seekr vision (Street View), navigation controls, memories, and chat.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add a Cesium ion access token. Copy `.env.example` to `.env` and paste
   your token from https://ion.cesium.com/tokens:

   ```bash
   cp .env.example .env
   ```

   ```
   VITE_CESIUM_ION_TOKEN=your-token-here
   ```

3. Start the dev server:

   ```bash
   npm run dev
   ```

## Stack

- Vite + React + TypeScript
- CesiumJS via `vite-plugin-cesium`
- Google Photorealistic 3D Tiles (loaded through Cesium ion)

## Assets

- `public/assets/models/Seeker.glb` — the Seekr avatar, reused from
  [flaspa/la-ai-navigator](https://github.com/flaspa/la-ai-navigator).
