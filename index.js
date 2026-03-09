

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTH_DIR = process.env.AUTH_DIR || './sessions';

const app = express();
app.use(express.json());

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── In-memory session store ───
const sessions = new Map();

// ─── Helper: get base URL from WEBHOOK_URL ───
function getBackendBaseUrl() {
  if (!WEBHOOK_URL) return null;
  try {
    const url = new URL(WEBHOOK_URL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return WEBHOOK_URL.replace(/\/api\/whatsapp\/.*$/, '');
  }
}

// ─── Helper: notify backend ───
async function notifyBackend(endpoint, payload) {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) {
    logger.warn('No WEBHOOK_URL configured, skipping backend notification');
    return;
  }
  const url = `${baseUrl}${endpoint}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    logger.info(`[${payload.sessionId}] Backend ${endpoint}: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    logger.error(`[${payload.sessionId}] Failed to notify backend ${endpoint}: ${err.message}`);
    return null;
  }
}

// ─── Create/connect a WhatsApp session ───
async function createSession(sessionId, type) {
  const sessionDir = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: true,
    browser: ['Xerxo AI', 'Chrome', '120.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  const sessionData = {
    sessionId,
    type: type || 'business',
    sock,
    status: 'waiting_scan',
    qrCode: null,
    qrRaw: null,
    phoneNumber: null,
    name: null,
    createdAt: new Date().toISOString(),
    connectedAt: null,
    lastActivity: new Date().toISOString(),
  };

  sessions.set(sessionId, sessionData);

  // ─── Handle connection updates ───
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = new Date().toISOString();

    if (qr) {
      try {
        session.qrCode = await QRCode.toDataURL(qr);
        session.qrRaw = qr;
        session.status = 'waiting_scan';
        logger.info(`[${sessionId}] QR code generated`);
      } catch (err) {
        logger.error(`[${sessionId}] QR generation error: ${err.message}`);
      }
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.connectedAt = new Date().toISOString();
      session.qrCode = null;
      session.qrRaw = null;

      // Get phone number from socket
      const user = sock.user;
      if (user) {
        session.phoneNumber = user.id.replace(/:.*$/, '');
        session.name = user.name || '';
      }

      logger.info(`[${sessionId}] WhatsApp connected! Phone: ${session.phoneNumber}`);

      // Notify backend of connection
      await notifyBackend('/api/whatsapp/connection-update', {
        sessionId,
        status: 'connected',
        phoneNumber: session.phoneNumber || '',
        name: session.name || '',
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.info(`[${sessionId}] Connection closed (code: ${statusCode}), reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Reconnect
        setTimeout(() => createSession(sessionId, session.type), 3000);
      } else {
        session.status = 'disconnected';
        session.phoneNumber = null;
        sessions.delete(sessionId);

        // Notify backend of disconnection
        await notifyBackend('/api/whatsapp/connection-update', {
          sessionId,
          status: 'disconnected',
        });
      }
    }
  });

  // ─── Save credentials on update ───
  sock.ev.on('creds.update', saveCreds);

  // ─── Handle incoming messages ───
  sock.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.lastActivity = new Date().toISOString();

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe === undefined) continue;

      const from = msg.key.remoteJid || '';
      const fromMe = msg.key.fromMe || false;

      // Extract text content
      let text = '';
      const m = msg.message;
      if (m.conversation) text = m.conversation;
      else if (m.extendedTextMessage?.text) text = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) text = m.imageMessage.caption;
      else if (m.videoMessage?.caption) text = m.videoMessage.caption;
      else if (m.documentMessage?.caption) text = m.documentMessage.caption;

      if (!text) continue;

      const myNumber = session.phoneNumber || '';
      logger.info(`[${sessionId}] Message received - from: ${from.split('@')[0]}, fromMe: ${fromMe}, myNumber: ${myNumber}`);
      logger.info(`[${sessionId}] Message content: ${text.substring(0, 200)}`);

      // Forward to backend
      const result = await notifyBackend('/api/whatsapp/process-incoming', {
        sessionId,
        event: 'message',
        data: {
          key: {
            remoteJid: from,
            fromMe: fromMe,
            id: msg.key.id,
          },
          message: msg.message,
          pushName: msg.pushName || '',
        },
        from: from,
        fromMe: fromMe,
        text: text,
        myNumber: myNumber,
      });

      if (result) {
        logger.info(`[${sessionId}] Backend processed message: ${JSON.stringify(result)}`);
      }
    }
  });

  return sessionData;
}

// ─── Restore sessions on startup ───
async function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    return;
  }
  const dirs = fs.readdirSync(AUTH_DIR).filter(d =>
    fs.statSync(path.join(AUTH_DIR, d)).isDirectory()
  );
  for (const dir of dirs) {
    const credsPath = path.join(AUTH_DIR, dir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      logger.info(`Restoring session: ${dir}`);
      try {
        await createSession(dir, 'business');
      } catch (err) {
        logger.error(`Failed to restore session ${dir}: ${err.message}`);
      }
    }
  }
}

// ═══════════════════════════════════════════
//  API ENDPOINTS
// ═══════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'baileys-whatsapp',
    activeSessions: sessions.size,
    uptime: process.uptime(),
    webhookUrl: WEBHOOK_URL ? 'configured' : 'not set',
  });
});

// List all sessions
app.get('/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      sessionId: id,
      status: s.status,
      type: s.type,
      createdAt: s.createdAt,
      connectedAt: s.connectedAt,
      lastActivity: s.lastActivity,
    });
  }
  res.json({ success: true, sessions: list });
});

// Create a new session
app.post('/session/create', async (req, res) => {
  try {
    const { sessionId, type } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // If session exists and is connected, return status
    const existing = sessions.get(sessionId);
    if (existing && existing.status === 'connected') {
      return res.json({
        success: true,
        sessionId,
        status: 'connected',
        phoneNumber: existing.phoneNumber,
        message: 'Session already connected',
      });
    }

    // Create or recreate session
    const session = await createSession(sessionId, type);

    // Wait briefly for QR to generate
    await new Promise(resolve => setTimeout(resolve, 3000));

    const updated = sessions.get(sessionId);
    res.json({
      success: true,
      sessionId,
      status: updated?.status || 'waiting_scan',
      qr_code: updated?.qrCode || null,
      expires_in: 60,
      message: updated?.qrCode ? 'Scan QR code with WhatsApp' : 'Generating QR code...',
    });
  } catch (err) {
    logger.error(`Session create error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get session status
app.get('/session/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.json({
      success: true,
      sessionId: req.params.sessionId,
      status: 'none',
      phoneNumber: null,
      qr_available: false,
      qr_code: null,
    });
  }
  res.json({
    success: true,
    sessionId: session.sessionId,
    status: session.status,
    type: session.type,
    phoneNumber: session.phoneNumber,
    createdAt: session.createdAt,
    connectedAt: session.connectedAt,
    lastActivity: session.lastActivity,
    qr_available: !!session.qrCode,
    qr_code: session.qrCode,
  });
});

// Get QR code
app.get('/session/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || !session.qrCode) {
    return res.status(404).json({ success: false, error: 'No QR code available' });
  }
  res.json({
    success: true,
    qr_code: session.qrCode,
    expires_in: 60,
  });
});

// Send a message
app.post('/session/:sessionId/send', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ success: false, error: 'Session not connected' });
  }

  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'to and message are required' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    session.lastActivity = new Date().toISOString();
    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    logger.error(`[${req.params.sessionId}] Send error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logout/disconnect session
app.post('/session/:sessionId/logout', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.json({ success: true, message: 'Session not found (already cleaned up)' });
  }

  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch (err) {
    logger.warn(`[${req.params.sessionId}] Logout error: ${err.message}`);
  }

  // Clean up session files
  const sessionDir = path.join(AUTH_DIR, req.params.sessionId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  sessions.delete(req.params.sessionId);
  res.json({ success: true, message: 'Logged out successfully' });
});

// ─── Start server ───
app.listen(PORT, async () => {
  logger.info(`Xerxo WhatsApp Bridge running on port ${PORT}`);
  logger.info(`Webhook URL: ${WEBHOOK_URL || 'NOT SET'}`);
  logger.info(`Backend base: ${getBackendBaseUrl() || 'NOT SET'}`);

  // Restore existing sessions
  await restoreSessions();
});
