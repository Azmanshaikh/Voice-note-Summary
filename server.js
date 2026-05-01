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
const express    = require('express');
const multer     = require('multer');
const axios      = require('axios');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const FormData   = require('form-data');
const { spawn }  = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const upload = multer({
  dest: 'tmp/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.match(/\.(mp3|wav|ogg|webm|m4a|mp4|flac)$/i);
    ok ? cb(null, true) : cb(new Error('Unsupported file type.'));
  }
});

const imageUpload = multer({
  dest: 'tmp/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.match(/^image\/(jpeg|png|webp)$/);
    ok ? cb(null, true) : cb(new Error('Unsupported image type. Use JPG, PNG, or WebP.'));
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

/**
 * Transcribe via Groq Whisper, then summarize via Groq LLaMA.
 */
async function groqProcess(filePath, apiKey, style = 'paragraph') {
  if (!apiKey) throw new Error('Groq API key missing.');

  const stylePrompt = {
    concise:   'Write a concise 2-3 sentence summary.',
    paragraph: 'Write a clear single-paragraph summary.',
    detailed:  'Write a detailed multi-paragraph summary covering all main points.',
    bullets:   'Write a summary as 4-6 bullet points.',
  }[style] || 'Write a clear single-paragraph summary.';

  // Step 1 — transcribe with Whisper
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename: 'audio.mp3', contentType: 'audio/mp3' });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'text');

  const { data: transcript } = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` }, maxBodyLength: Infinity }
  );

  // Step 2 — summarize + key points + solution with LLaMA
  const prompt = `You are a smart note-taking assistant. Given this transcript, do three things:
1. ${stylePrompt}
2. Extract exactly 5 key points as short, clear sentences.
3. Provide a direct solution, answer, or helpful advice to any problems or questions mentioned.

Transcript:
"""
${transcript}
"""

Respond ONLY in this strict JSON format (no markdown or extra text):
{"summary":"...","keyPoints":["...","...","...","...","..."],"solution":"..."}`;

  const { data: chat } = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.3 },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }
  );

  const raw = chat.choices?.[0]?.message?.content;
  if (!raw) throw new Error('No content returned from Groq');

  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  return { transcript, ...parsed };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/process  — all-in-one
 * Multipart: file (audio), style?
 * Header:    x-gemini-key
 */
app.post('/api/process', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided.' });

  const groqKey   = req.headers['x-groq-key']   || process.env.GROQ_API_KEY;
  const geminiKey = req.headers['x-gemini-key']  || process.env.GEMINI_API_KEY;
  const style     = req.body.style || 'paragraph';

  if (!groqKey && !geminiKey) {
    cleanup(req.file.path);
    return res.status(401).json({ error: 'Missing API key (GROQ_API_KEY or GEMINI_API_KEY).' });
  }

  let result, provider;
  try {
    if (groqKey) {
      result   = await groqProcess(req.file.path, groqKey, style);
      provider = 'groq';
    } else {
      result   = await geminiProcess(req.file.path, geminiKey, style);
      provider = 'gemini';
    }
  } catch (err) {
    cleanup(req.file?.path);
    const msg = err.response?.data?.error?.message || err.message;
    const who = groqKey ? 'Groq' : 'Gemini';
    return res.status(500).json({ error: `${who}: ${msg}` });
  }

  cleanup(req.file.path);
  res.json({
    success:    true,
    provider,
    transcript: result.transcript,
    language:   'en',
    duration:   0,
    wordCount:  (result.transcript || '').split(/\s+/).filter(Boolean).length,
    summary:    result.summary,
    keyPoints:  result.keyPoints || [],
    solution:   result.solution || '',
  });
});

// ─── URL / YouTube Route ──────────────────────────────────────────────────────

/**
 * POST /api/process-url
 * Body: { url, style? }
 * Downloads audio via yt-dlp, then runs the same Groq→Gemini pipeline.
 */
app.post('/api/process-url', express.json(), async (req, res) => {
  const { url, style = 'paragraph' } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided.' });

  // Basic URL validation before spawning yt-dlp
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL. Please paste a full URL starting with https://' });
  }

  const groqKey   = req.headers['x-groq-key']  || process.env.GROQ_API_KEY;
  const geminiKey = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) return res.status(401).json({ error: 'Missing API key.' });

  const outBase = path.join('tmp', `url_${Date.now()}`);
  let audioOut  = null;

  try {
    // Download best native audio — no ffmpeg conversion needed
    await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '--format', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '--no-playlist',
        '-o', `${outBase}.%(ext)s`,
        url,
      ]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => reject(
        err.code === 'ENOENT'
          ? new Error('yt-dlp is not installed. Run: pip install yt-dlp')
          : err
      ));
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp failed: ${stderr.slice(-300)}`)));
    });

    // Find whichever file yt-dlp actually created (extension varies)
    const baseName  = path.basename(outBase);
    const downloaded = fs.readdirSync('tmp').find(f => f.startsWith(baseName));
    audioOut = downloaded ? path.join('tmp', downloaded) : null;

    if (!audioOut) return res.status(500).json({ error: 'Audio extraction produced no output file.' });

    let result, provider;
    if (groqKey) {
      result = await groqProcess(audioOut, groqKey, style);
      provider = 'groq';
    } else {
      result = await geminiProcess(audioOut, geminiKey, style);
      provider = 'gemini';
    }

    cleanup(audioOut);
    return res.json({
      success:    true,
      provider,
      source:     'url',
      transcript: result.transcript,
      language:   'en',
      duration:   0,
      wordCount:  (result.transcript || '').split(/\s+/).filter(Boolean).length,
      summary:    result.summary,
      keyPoints:  result.keyPoints || [],
      solution:   result.solution || '',
    });
  } catch (err) {
    cleanup(audioOut);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─── Chat Route ───────────────────────────────────────────────────────────────

/**
 * POST /api/chat
 * Body:    { message, transcript, history: [{role,content}] }
 * Headers: x-groq-key | x-gemini-key
 * Returns: { reply, provider }
 */
app.post('/api/chat', express.json(), async (req, res) => {
  const { message, transcript, history = [] } = req.body || {};
  const groqKey   = req.headers['x-groq-key']  || process.env.GROQ_API_KEY;
  const geminiKey = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;

  if (!message)             return res.status(400).json({ error: 'No message provided.' });
  if (!groqKey && !geminiKey) return res.status(401).json({ error: 'Missing API key.' });

  const systemPrompt = transcript
    ? `You are a helpful assistant. The user recorded a voice note with this transcript:\n\n"""\n${transcript}\n"""\n\nAnswer questions about it concisely and helpfully. If asked something outside the transcript, answer from your general knowledge but note it isn't from the recording.`
    : 'You are a helpful assistant.';

  try {
    let reply, provider;

    if (groqKey) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ];
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages, temperature: 0.5, max_tokens: 1024 },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` } }
      );
      reply    = data.choices?.[0]?.message?.content;
      provider = 'groq';
    } else {
      const contents = [
        ...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: message }] },
      ];
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        { system_instruction: { parts: [{ text: systemPrompt }] }, contents },
        { headers: { 'Content-Type': 'application/json' } }
      );
      reply    = data.candidates?.[0]?.content?.parts?.[0]?.text;
      provider = 'gemini';
    }

    if (!reply) throw new Error('No reply from AI');
    res.json({ reply, provider });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─── Avatar Helpers ───────────────────────────────────────────────────────────

// Convert text → MP3 using free Google Translate TTS (no key needed)
function textToSpeechFile(text) {
  return new Promise((resolve, reject) => {
    const gTTS    = require('node-gtts');
    const tts     = gTTS('en');
    const outPath = path.join('tmp', `tts_${Date.now()}.mp3`);
    // Truncate to avoid hitting TTS limits
    const chunk   = text.length > 800 ? text.substring(0, 797) + '...' : text;
    tts.save(outPath, chunk, (err) => {
      if (err) reject(new Error('TTS failed: ' + err.message));
      else     resolve(outPath);
    });
  });
}

// Send audio + face image to NVIDIA Audio2Face-2D NIM → returns MP4 buffer
// Endpoint documented at: https://build.nvidia.com/nvidia/audio2face-2d
async function callNvidiaAudio2Face(audioPath, facePath, nvidiaKey) {
  const form = new FormData();
  form.append('audio', fs.createReadStream(audioPath), {
    filename:    'speech.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('image', fs.createReadStream(facePath), {
    filename:    'face.jpg',
    contentType: 'image/jpeg',
  });

  const { data } = await axios.post(
    'https://ai.api.nvidia.com/v1/cv/nvidia/audio2face-2d',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${nvidiaKey}`,
        Accept:        'video/mp4',
      },
      responseType:      'arraybuffer',
      maxBodyLength:     Infinity,
      maxContentLength:  Infinity,
      timeout:           120_000,
    }
  );
  return Buffer.from(data);
}

// ─── Avatar Routes ────────────────────────────────────────────────────────────

// POST /api/avatar/face  — save the user's face image for avatar generation
app.post('/api/avatar/face', imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided.' });
  const dest = path.join('tmp', 'user_avatar.jpg');
  try {
    fs.renameSync(req.file.path, dest);
    res.json({ success: true });
  } catch (err) {
    cleanup(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/avatar  — summary text → TTS → NVIDIA Audio2Face-2D → MP4 video
app.post('/api/avatar', express.json(), async (req, res) => {
  const { text } = req.body || {};
  const nvidiaKey = req.headers['x-nvidia-key'] || process.env.NVIDIA_API_KEY;

  if (!text)       return res.status(400).json({ error: 'No text provided.' });
  if (!nvidiaKey)  return res.status(401).json({ error: 'Missing NVIDIA API key. Get one free at build.nvidia.com' });

  const facePath = path.join('tmp', 'user_avatar.jpg');
  if (!fs.existsSync(facePath)) {
    return res.status(400).json({ error: 'No face image uploaded. Please upload a face image in Settings first.' });
  }

  let audioPath = null;
  try {
    audioPath         = await textToSpeechFile(text);
    const videoBuffer = await callNvidiaAudio2Face(audioPath, facePath, nvidiaKey);
    cleanup(audioPath);

    res.set({ 'Content-Type': 'video/mp4', 'Content-Length': videoBuffer.length });
    res.send(videoBuffer);
  } catch (err) {
    cleanup(audioPath);
    let msg = err.message;
    if (err.response?.data) {
      try { msg = JSON.parse(Buffer.from(err.response.data).toString()).detail || msg; } catch (_) {}
    }
    res.status(500).json({ error: msg });
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
