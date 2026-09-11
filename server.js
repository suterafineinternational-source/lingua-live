import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 5173);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_TARGETS = new Set(['en','es','pt','fr','ja','ru','zh','de','ko','hi','id','vi','it']);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, realtime: Boolean(process.env.OPENAI_API_KEY) });
});

app.post('/api/session', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OPENAI_API_KEY non configurata sul server.' });
    }

    const targetLanguage = String(req.body?.targetLanguage || 'en').toLowerCase();
    if (!ALLOWED_TARGETS.has(targetLanguage)) {
      return res.status(400).json({ error: 'Lingua di destinazione non supportata.' });
    }

    const response = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: 'near_field' }
            },
            output: { language: targetLanguage }
          }
        }
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    res.json({
      client_secret: data.value,
      expires_at: data.expires_at,
      session_id: data.session?.id,
      targetLanguage
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || 'Errore nella creazione della sessione.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Lingua Live: http://localhost:${port}`);
});
