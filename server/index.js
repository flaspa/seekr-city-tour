// Minimal backend for Seekr City Tour's Memories.ai + Claude integration.
//
// Keeps MEMORIES_API_KEY and ANTHROPIC_API_KEY server-side only. Endpoints:
//   POST /api/memories         upload/index a captured memory image
//   POST /api/memories/search  semantic search over the private library
//   POST /api/chat             conversational recall over local memories,
//                              grounded via Memories.ai search + Claude
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const CLAUDE_MODEL = 'claude-sonnet-5'
const PORT = process.env.PORT || 8787

if (!MEMORIES_API_KEY) {
  console.warn(
    'MEMORIES_API_KEY is not set - /api/memories requests will fail until it is configured.',
  )
}
if (!ANTHROPIC_API_KEY) {
  console.warn(
    'ANTHROPIC_API_KEY is not set - /api/chat requests will fail until it is configured.',
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

// Shared by POST /api/memories/search and POST /api/chat (recall).
async function searchMemoriesAi(query) {
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
    throw new Error(`Memories.ai search failed (${searchResponse.status})`)
  }
  return (searchJson?.results ?? []).map((item) => ({
    id: item.video_id,
    score: item.score,
  }))
}

async function askClaude(system, userMessage) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      `Claude request failed (${response.status}): ${JSON.stringify(json)}`,
    )
  }
  return json?.content?.[0]?.text ?? ''
}

function formatMemory(m) {
  const place = m.destinationLabel || m.city || 'an unknown place'
  const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : 'unknown time'
  const notes = (m.notes ?? []).length
    ? ` User said there: ${m.notes.map((n) => `"${n}"`).join('; ')}.`
    : ''
  return `- ${place} (${m.city}) at ${when}, coords ${m.lat?.toFixed(4)}, ${m.lon?.toFixed(4)}.${notes}`
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
    const results = await searchMemoriesAi(query)
    return res.json({ ok: true, results })
  } catch (error) {
    console.error('POST /api/memories/search failed:', error)
    return res.status(500).json({ ok: false, error: String(error.message ?? error) })
  }
})

// Minimal conversational recall over existing Seekr memories.
// Receives the user's message plus the frontend's own local memory objects
// (no server-side memory store - the frontend already holds this state).
// Two paths:
//   - "tell me the story of our walk" -> chronological narrative from all
//     memories, ordered by timestamp.
//   - anything else -> best-effort grounding: try a Memories.ai semantic
//     search for a matching memory, falling back to simple local text
//     matching (destination/city) or the current memory if search finds
//     nothing, then ask Claude to answer using only that context.
app.post('/api/chat', async (req, res) => {
  const { message, currentMemoryId, memories } = req.body ?? {}
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'message is required' })
  }
  const localMemories = Array.isArray(memories) ? memories : []

  try {
    const isTripSummary = /story|our walk|walked|trip summary|recap/i.test(message)

    if (isTripSummary) {
      const ordered = [...localMemories].sort((a, b) => a.timestamp - b.timestamp)
      const context = ordered.map(formatMemory).join('\n') || '(no memories yet)'
      const answer = await askClaude(
        'You are Seekr, a friendly companion recalling a city walk. Using ONLY the memories listed below, write a short (3-5 sentence) chronological story of the walk. Do not invent places or details not listed.\n\nMemories, in order:\n' +
          context,
        message,
      )
      return res.json({ answer })
    }

    let matched = null
    try {
      const results = await searchMemoriesAi(message)
      for (const r of results) {
        const found = localMemories.find((m) => m.memoriesId === r.id)
        if (found) {
          matched = found
          break
        }
      }
    } catch (error) {
      console.warn('Memories.ai search unavailable for chat, falling back:', error)
    }

    if (!matched) {
      const lower = message.toLowerCase()
      matched = localMemories.find(
        (m) =>
          (m.destinationLabel && lower.includes(m.destinationLabel.toLowerCase())) ||
          (m.city && lower.includes(m.city.toLowerCase())),
      )
    }
    if (!matched && currentMemoryId) {
      matched = localMemories.find((m) => m.id === currentMemoryId) ?? null
    }

    const context = matched
      ? formatMemory(matched)
      : '(no relevant memory found yet)'
    const answer = await askClaude(
      'You are Seekr, a friendly companion recalling a city walk with the user. Answer the user using ONLY the memory context below - do not invent places, images, or facts not given. If the user asks to see/show something and an image exists for this memory, say you are showing it. Keep answers to 1-3 sentences.\n\nRelevant memory:\n' +
        context,
      message,
    )
    return res.json({ answer, memoryId: matched?.id })
  } catch (error) {
    console.error('POST /api/chat failed:', error)
    return res.status(500).json({ ok: false, error: String(error.message ?? error) })
  }
})

app.listen(PORT, () => {
  console.log(`Seekr memories server listening on http://localhost:${PORT}`)
})
