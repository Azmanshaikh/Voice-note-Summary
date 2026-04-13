/**
 * VoiceNote — Speech → Text → Summary
 * Backend Server (Node.js + Express)
 *
 * APIs used:
 *   - Google Gemini 1.5 Flash (Multimodal Audio + Text)
 *
 * Setup:
 *   npm install
 *   cp .env.example .env   # add your GEMINI_API_KEY
 *   node server.js
 *
 * Endpoints:
 *   POST /api/process      — audio → transcript + summary + key points (all-in-one via Gemini)
 */

require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const axios     = require('axios');
const cors      = require('cors');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const upload = multer({
  dest: 'tmp/',
  limits: { fileSize: 20 * 1024 * 1024 }, // Max 20MB for Gemini inlineData
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.match(/\.(mp3|wav|ogg|webm|m4a|mp4|flac)$/i);
    ok ? cb(null, true) : cb(new Error('Unsupported file type.'));
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanup(p) { if (p) fs.unlink(p, () => {}); }

/**
 * Perform all-in-one transcription and summarization using Google Gemini 1.5 Flash.
 */
async function geminiProcess(filePath, apiKey, style = 'paragraph') {
  if (!apiKey) throw new Error('API Key missing.');

  const audioBase64 = fs.readFileSync(filePath).toString('base64');

  const stylePrompt = {
    concise:   'Write a concise 2-3 sentence summary.',
    paragraph: 'Write a clear single-paragraph summary.',
    detailed:  'Write a detailed multi-paragraph summary covering all main points.',
    bullets:   'Write a summary as 4-6 bullet points.',
  }[style] || 'Write a clear single-paragraph summary.';

  const prompt = `You are a smart note-taking assistant. Given this audio, do four things:
1. Provide a full transcription.
2. ${stylePrompt}
3. Extract exactly 5 key points as short, clear sentences.
4. Provide a direct solution, answer, or helpful advice to any problems or questions mentioned in the audio.

Respond ONLY in this strict JSON format (no markdown formatting or extra text):
{"transcript":"...","summary":"...","keyPoints":["...","...","...","...","..."],"solution":"..."}`;

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "audio/mp3", data: audioBase64 } }
      ]
    }]
  };

  const headers = { 'Content-Type': 'application/json' };

  const { data } = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    requestBody,
    { headers, maxBodyLength: Infinity, maxContentLength: Infinity }
  );

  const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawContent) throw new Error('No content returned from Gemini');

  const cleanRaw = rawContent.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleanRaw);
  } catch(e) {
    throw new Error('Failed to parse Gemini JSON response: ' + cleanRaw);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/process  — all-in-one
 * Multipart: file (audio), style?
 * Header:    x-gemini-key
 */
app.post('/api/process', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided.' });

  const apiKey   = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  const style    = req.body.style || 'paragraph';

  if (!apiKey) {
    cleanup(req.file.path);
    return res.status(401).json({ error: 'Missing Gemini API key.' });
  }

  try {
    const result = await geminiProcess(req.file.path, apiKey, style);
    cleanup(req.file.path);

    // Provide the successful response conforming to the expected frontend schema
    res.json({
      success:    true,
      transcript: result.transcript,
      language:   'en',
      duration:   0,
      wordCount:  (result.transcript || '').split(/\s+/).filter(Boolean).length,
      summary:    result.summary,
      keyPoints:  result.keyPoints || [],
      solution:   result.solution || '',
    });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Serve static frontend
app.use(express.static('public'));

app.get('/health', (_, res) => res.json({ status: 'ok', port: PORT }));

app.use((err, req, res, next) => {
  cleanup(req.file?.path);
  res.status(400).json({ error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (!fs.existsSync('tmp')) fs.mkdirSync('tmp');

app.listen(PORT, () => {
  console.log(`\n🎙️  VoiceNote backend → http://localhost:${PORT}`);
  console.log(`   POST /api/process     — audio → transcript + summary + key points (Gemini)\n`);
});
