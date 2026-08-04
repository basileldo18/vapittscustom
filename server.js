require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Log incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Google Cloud Text-to-Speech client initialization
let ttsClient = null;
let ttsInitError = null;

try {
  let config = {};
  const localCredsPath = path.join(__dirname, 'google-credentials.json');

  if (fs.existsSync(localCredsPath)) {
    console.log('[TTS] Found local google-credentials.json file. Loading credentials...');
    config.credentials = JSON.parse(fs.readFileSync(localCredsPath, 'utf-8'));
  } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log('[TTS] GOOGLE_CREDENTIALS_JSON env var detected. Loading stringified credentials...');
    try {
      const trimmedEnv = process.env.GOOGLE_CREDENTIALS_JSON.trim();
      config.credentials = JSON.parse(trimmedEnv);
    } catch (parseErr) {
      const rawVal = process.env.GOOGLE_CREDENTIALS_JSON;
      const len = rawVal ? rawVal.length : 0;
      const lastChars = rawVal ? rawVal.slice(-40) : '';
      const nearErr = rawVal ? rawVal.slice(Math.max(0, 2320), Math.min(len, 2370)) : '';
      throw new Error(`JSON format error: ${parseErr.message}. Total length: ${len}. Last 40 chars: "${lastChars}". Chars near 2340: "${nearErr}"`);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`[TTS] GOOGLE_APPLICATION_CREDENTIALS env var detected points to path: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
  } else {
    console.log('[TTS] WARNING: No Google Service Account credentials found. Please add a "google-credentials.json" file or set GOOGLE_CREDENTIALS_JSON env variable to authenticate Google TTS.');
  }

  ttsClient = new textToSpeech.TextToSpeechClient(config);
  console.log('[TTS] Google Cloud Text-to-Speech client initialized.');
} catch (err) {
  ttsInitError = err;
  console.error('[TTS] Failed to initialize GCP Text-to-Speech client:', err.message);
}

// Custom TTS endpoint for Vapi
app.post('/tts', async (req, res) => {
  console.log('[TTS] Request body:', JSON.stringify(req.body, null, 2));

  // Vapi routes request parameters under the "message" object
  const bodySource = req.body.message || req.body;
  const { text, voiceId, sampleRate } = bodySource;

  if (!text) {
    return res.status(400).send('No text provided');
  }

  if (!ttsClient) {
    console.error('[TTS Error] Client not initialized:', ttsInitError?.message);
    return res.status(500).json({
      error: 'Google Cloud TTS Client is not authenticated. Please add "google-credentials.json" or set GOOGLE_CREDENTIALS_JSON/GOOGLE_APPLICATION_CREDENTIALS.',
      details: ttsInitError ? ttsInitError.message : 'No credentials provided'
    });
  }

  const voiceName = voiceId || 'en-US-Journey-F';
  let languageCode = 'en-US';
  if (voiceName && typeof voiceName === 'string') {
    const parts = voiceName.split('-');
    if (parts.length >= 2) {
      languageCode = `${parts[0]}-${parts[1]}`;
    }
  }

  const rateHertz = sampleRate || 24000;

  // Dynamically map GCP TTS voice depending on text script (Malayalam, Hindi, Tamil, Arabic, English)
  let selectedVoice = voiceName;
  let selectedLang = languageCode;

  if (/[\u0D00-\u0D7F]/.test(text)) {
    selectedLang = 'ml-IN';
    selectedVoice = 'ml-IN-Wavenet-C'; // Premium Female WaveNet Malayalam Voice
    console.log(`[TTS] Malayalam script detected -> using high-quality WaveNet ${selectedVoice}`);
  } else if (/[\u0900-\u097F]/.test(text)) {
    selectedLang = 'hi-IN';
    selectedVoice = 'hi-IN-Neural2-A'; // Premium Female Neural2 Hindi Voice
    console.log(`[TTS] Hindi script detected -> using high-quality Neural2 ${selectedVoice}`);
  } else if (/[\u0B80-\u0BFF]/.test(text)) {
    selectedLang = 'ta-IN';
    selectedVoice = 'ta-IN-Wavenet-A'; // Premium Female WaveNet Tamil Voice
    console.log(`[TTS] Tamil script detected -> using high-quality WaveNet ${selectedVoice}`);
  } else if (/[\u0600-\u06FF]/.test(text)) {
    selectedLang = 'ar-XA';
    selectedVoice = 'ar-XA-Wavenet-A'; // Premium Female WaveNet Arabic Voice
    console.log(`[TTS] Arabic script detected -> using high-quality WaveNet ${selectedVoice}`);
  }

  console.log(`[TTS] Synthesizing: "${text}" | Voice: ${selectedVoice} | Lang: ${selectedLang} | Rate: ${rateHertz}Hz`);

  try {
    const request = {
      input: { text },
      voice: { languageCode: selectedLang, name: selectedVoice },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: rateHertz
      },
    };

    const [ttsResponse] = await ttsClient.synthesizeSpeech(request);

    // LINEAR16 returns base64 raw WAV buffer. WAV contains a 44-byte header.
    // We slice the header off to return raw PCM audio as Vapi expects.
    const wavBuffer = ttsResponse.audioContent;

    if (!wavBuffer || wavBuffer.length <= 44) {
      throw new Error('Received empty or invalid audio content from Google TTS.');
    }

    const pcmBuffer = wavBuffer.slice(44);

    res.setHeader('Content-Type', 'audio/pcm');
    res.send(pcmBuffer);
    console.log(`[TTS] Synthesis complete. Sent ${pcmBuffer.length} bytes of raw PCM.`);
  } catch (err) {
    console.error('[TTS Error] Synthesis failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook endpoint for Vapi custom tool calls (e.g. query_info)
app.post('/webhook', async (req, res) => {
  console.log('[Webhook] Received tool call request from Vapi:', JSON.stringify(req.body, null, 2));

  const bodySource = req.body || {};
  const message = bodySource.message || {};

  // Extract toolCalls from Vapi's webhook request payload
  let toolCalls = [];
  if (message.toolCall) {
    toolCalls.push(message.toolCall);
  } else if (message.toolCalls && Array.isArray(message.toolCalls)) {
    toolCalls = message.toolCalls;
  } else if (bodySource.toolCalls && Array.isArray(bodySource.toolCalls)) {
    toolCalls = bodySource.toolCalls;
  } else if (bodySource.toolCall) {
    toolCalls.push(bodySource.toolCall);
  }

  if (toolCalls.length === 0) {
    console.log('[Webhook] No tool calls found in request body.');
    return res.status(200).json({ message: "No tool calls detected" });
  }

  const results = [];
  for (const toolCall of toolCalls) {
    const toolCallId = toolCall.id;
    const functionName = toolCall.function?.name;
    const args = toolCall.function?.arguments || {};

    console.log(`[Webhook] Processing tool call ID: ${toolCallId} | Function: ${functionName} | Args:`, JSON.stringify(args));

    if (functionName === 'query_info') {
      const query = (args.query || '').toLowerCase();
      let result = '';

      if (query.includes('open') || query.includes('hour') || query.includes('time') || query.includes('day')) {
        result = 'Guardian Angel Homecare offices are open Monday to Saturday from 9:00 AM to 5:30 PM. We are closed on Sundays. Please note our physical office branches have specific daily opening hours; do not say the office is open 24/7.';
      } else if (query.includes('contact') || query.includes('number') || query.includes('phone') || query.includes('call') || query.includes('mobile')) {
        result = 'For customer care and services, contact Guardian Angel Homecare directly at +91 8589098181.';
      } else if (query.includes('thodupuzha')) {
        result = 'The Thodupuzha branch office is located at: Guardian Angel Homecare, 2nd Floor, Carmel Centre, Temple Road, Thodupuzha, Kerala - 685584. Contact customer care at +91 8589098181.';
      } else if (query.includes('kochi') || query.includes('cochin') || query.includes('palarivattom')) {
        result = 'The Kochi head office is located at: Guardian Angel Homecare, 3rd Floor, Pious Chambers, Palarivattom, Kochi, Kerala - 682025. Contact customer care at +91 8589098181.';
      } else if (query.includes('mou') || query.includes('agreement') || query.includes('partnership')) {
        result = 'Guardian Angel Homecare has signed Memorandums of Understanding (MoUs) with leading hospitals and nursing colleges in Kerala to collaborate on training and recruiting qualified healthcare personnel.';
      } else if (query.includes('news') || query.includes('event')) {
        result = 'Guardian Angel Homecare recently held caregiver training sessions and community initiatives in Kochi, focusing on elderly care and advanced home nursing skills.';
      } else if (query.includes('service') || query.includes('nurs') || query.includes('care') || query.includes('physio') || query.includes('elderly')) {
        result = 'Guardian Angel Homecare provides skilled nursing care, patient caregiver support at home, post-operative care, elderly care, infant/baby care, and home physiotherapy services.';
      } else if (query.includes('team') || query.includes('doctor') || query.includes('nurse') || query.includes('staff') || query.includes('people')) {
        result = 'Our professional team consists of certified nurses, experienced home caregivers, qualified physiotherapists, and a customer support team working under the guidance of medical advisors.';
      } else {
        result = 'Guardian Angel Homecare (GAHC) is a premier homecare provider in Kerala, offering skilled nursing, caregiver, post-operative, elderly, and physiotherapy services at home. For bookings, scheduling, or inquiries, please contact our customer care directly at +91 8589098181.';
      }

      console.log(`[Webhook] Result matches query "${query}":`, result);

      results.push({
        toolCallId: toolCallId,
        result: result
      });
    } else {
      results.push({
        toolCallId: toolCallId,
        result: `Tool ${functionName} executed.`
      });
    }
  }

  console.log('[Webhook] Returning results:', JSON.stringify({ results }, null, 2));
  return res.status(200).json({ results });
});

// Create HTTP server
const server = http.createServer(app);

// Run server
server.listen(PORT, () => {
  console.log(`GAHC Voice Bridge running on http://localhost:${PORT}`);
  console.log(`Custom TTS endpoint: http://localhost:${PORT}/tts`);
  console.log(`Tool Webhook endpoint: http://localhost:${PORT}/webhook`);
});
