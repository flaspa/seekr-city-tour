// Minimal backend for Seekr City Tour's Memories.ai integration.
//
// Keeps MEMORIES_API_KEY server-side only. Two endpoints:
//   POST /api/memories         upload/index a captured memory image
//   POST /api/memories/search  semantic search over the private library
//
// API contract: Memories.ai "Datalake" product, https://api.memories.ai/serve.
// Verified directly against the live server during implementation - the
// older "Visual Search v1" family documented in memories-cli
// (https://github.com/Memories-ai-labs/memories-cli) returns a routing
// error ("No static resource ...") for every endpoint on this deployment,
// so this integration targets the Datalake endpoints instead, per
// https://docs.memories.ai/datalake (collections, videos, search):
//   - Auth header: `Authorization: <api key>` (raw key, no "Bearer" prefix -
//     OpenAPI securityScheme "ApiKeyAuth": in: header, name: Authorization).
//   - POST /datalake/v1/collections  { name } -> { id }
//   - POST /datalake/v1/videos       { collection_id, source_url,
//       captured_at, location: {lat, lng}, metadata } -> { video_id, ... }
//   - POST /datalake/v1/search       { collection_id, targets, query,
//       top_k } -> { results: [{ video_id, score, thumbnail_url, ... }] }

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Reuse the existing root .env (already holds MEMORIES_API_KEY) instead of
// requiring a second copy of the secret for local dev.
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const MEMORIES_API_KEY = process.env.MEMORIES_API_KEY
const MEMORIES_BASE_URL = 'https://api.memories.ai/serve/datalake/v1'
const COLLECTION_NAME = 'seekr-memories'
const PORT = process.env.PORT || 8787

if (!MEMORIES_API_KEY) {
  console.warn(
    'MEMORIES_API_KEY is not set - /api/memories requests will fail until it is configured.',
  )
}

function memoriesHeaders(extra) {
  return { Authorization: MEMORIES_API_KEY, ...extra }
}

// The collection is created once per server process and reused (no
// database needed for this milestone).
let collectionIdPromise = null

async function getCollectionId() {
  if (collectionIdPromise) return collectionIdPromise
  collectionIdPromise = (async () => {
    const response = await fetch(`${MEMORIES_BASE_URL}/collections`, {
      method: 'POST',
      headers: memoriesHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: COLLECTION_NAME }),
    })
    const json = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        `Memories.ai collection creation failed (${response.status}): ${JSON.stringify(json)}`,
      )
    }
    return json.id
  })()
  return collectionIdPromise
}

const app = express()
app.use(cors())
app.use(express.json())

app.post('/api/memories', async (req, res) => {
  if (!MEMORIES_API_KEY) {
    return res.status(500).json({ ok: false, error: 'MEMORIES_API_KEY not configured' })
  }

  const { imageUrl, lat, lon, timestamp } = req.body ?? {}
  if (!imageUrl) {
    return res.status(400).json({ ok: false, error: 'imageUrl is required' })
  }

  try {
    const collectionId = await getCollectionId()

    const body = {
      collection_id: collectionId,
      source_url: imageUrl,
    }
    if (timestamp) body.captured_at = new Date(timestamp).toISOString()
    if (typeof lat === 'number' && typeof lon === 'number') {
      body.location = { lat, lng: lon }
    }

    const uploadResponse = await fetch(`${MEMORIES_BASE_URL}/videos`, {
      method: 'POST',
      headers: memoriesHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const uploadJson = await uploadResponse.json().catch(() => null)

    if (!uploadResponse.ok) {
      return res.status(uploadResponse.status).json({
        ok: false,
        error: 'Memories.ai upload failed',
        raw: uploadJson,
      })
    }

    return res.json({ ok: true, memoriesId: uploadJson?.video_id ?? null, raw: uploadJson })
  } catch (error) {
    console.error('POST /api/memories failed:', error)
    return res.status(500).json({ ok: false, error: String(error.message ?? error) })
  }
})

app.post('/api/memories/search', async (req, res) => {
  if (!MEMORIES_API_KEY) {
    return res.status(500).json({ ok: false, error: 'MEMORIES_API_KEY not configured' })
  }

  const { query } = req.body ?? {}
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ ok: false, error: 'query is required' })
  }

  try {
    const collectionId = await getCollectionId()

    const searchResponse = await fetch(`${MEMORIES_BASE_URL}/search`, {
      method: 'POST',
      headers: memoriesHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        collection_id: collectionId,
        targets: ['frame_embedding', 'caption'],
        query,
        top_k: 10,
      }),
    })
    const searchJson = await searchResponse.json().catch(() => null)

    if (!searchResponse.ok) {
      return res.status(searchResponse.status).json({
        ok: false,
        error: 'Memories.ai search failed',
        raw: searchJson,
      })
    }

    const results = (searchJson?.results ?? []).map((item) => ({
      id: item.video_id,
      score: item.score,
      raw: item,
    }))
    return res.json({ ok: true, results, raw: searchJson })
  } catch (error) {
    console.error('POST /api/memories/search failed:', error)
    return res.status(500).json({ ok: false, error: String(error.message ?? error) })
  }
})

app.listen(PORT, () => {
  console.log(`Seekr memories server listening on http://localhost:${PORT}`)
})
