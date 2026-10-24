require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const multer = require('multer');
const { parse } = require('csv-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, getContentType } = require('@whiskeysockets/baileys');

// ─── Express + Socket.io ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Gemini ───────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { temperature: 0.75, maxOutputTokens: 250 }
});

// ─── Multer ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, 'contacts_' + Date.now() + '.csv')
});
const upload = multer({ storage });
fs.mkdirSync('uploads', { recursive: true });

// ─── Config helpers ───────────────────────────────────────────────────
const ALLOWED_PATH  = './config/allowedNumbers.json';
const PERSONA_PATH  = './config/persona.json';
const RECEIPTS_PATH = './config/receipts.json';
const REPLIES_PATH  = './config/replies.json';

function loadAllowed()  { try { return JSON.parse(fs.readFileSync(ALLOWED_PATH,  'utf8')); } catch { return []; } }
function saveAllowed(l) { fs.writeFileSync(ALLOWED_PATH,  JSON.stringify(l, null, 2)); }
function loadPersona()  { try { return JSON.parse(fs.readFileSync(PERSONA_PATH,  'utf8')); } catch { return {}; } }
function savePersona(p) { fs.writeFileSync(PERSONA_PATH,  JSON.stringify(p, null, 2)); }

// Read-receipts: { [msgId]: { jid, name, phone, sentAt, seenAt, text } }
function loadReceipts()  { try { return JSON.parse(fs.readFileSync(RECEIPTS_PATH, 'utf8')); } catch { return {}; } }
function saveReceipts(r) { fs.writeFileSync(RECEIPTS_PATH, JSON.stringify(r, null, 2)); }

// Replies: [ { id, from, name, phone, text, time, isHotLead, thread: [{role,text,time}] } ]
function loadReplies()  { try { return JSON.parse(fs.readFileSync(REPLIES_PATH,  'utf8')); } catch { return []; } }
function saveReplies(r) { fs.writeFileSync(REPLIES_PATH,  JSON.stringify(r, null, 2)); }

// ─── Ensure config dir ────────────────────────────────────────────────
fs.mkdirSync('./config', { recursive: true });

// ─── Global state ─────────────────────────────────────────────────────
let sock             = null;
let connectionStatus = 'disconnected';
let currentQR        = null;
let aiEnabled        = false;
let conversations    = {};
let activityLog      = [];
let inbox            = [];

// Receipt tracking: msgId → { jid, name, phone, sentAt, text, seenAt? }
let receipts = loadReceipts();

// Replies from campaign contacts (or any contact)
let replies  = loadReplies();

// ─── Campaign state ───────────────────────────────────────────────────
let csvContacts    = [];
let campaignRunning = false;
let campaignPaused  = false;
let campaignAbort   = false;
let dailySentCount  = 0;
let lastSentDate    = null;
let campaignStats   = { total: 0, sent: 0, seen: 0, replied: 0 };
const DAILY_LIMIT   = 200;
const DELAY_MIN     = 8000;
const DELAY_MAX     = 20000;

// ─── Helpers ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const emit  = (ev, data) => io.emit(ev, data);

function normalizeJID(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n + '@s.whatsapp.net';
}

function cleanPhone(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n;
}

function isAllowed(jid) {
  if (!jid) return false;
  const allowed = loadAllowed();
  if (jid.endsWith('@s.whatsapp.net')) return allowed.some(c => normalizeJID(c.phone) === jid);
  if (jid.endsWith('@lid') && sock) {
    try {
      const contacts = sock.store?.contacts || {};
      const resolved = Object.values(contacts).find(c => c.lid === jid || c.id === jid);
      if (resolved?.id?.endsWith('@s.whatsapp.net')) return allowed.some(c => normalizeJID(c.phone) === resolved.id);
    } catch (_) {}
  }
  return false;
}

function getContactName(jid) {
  const allowed = loadAllowed();
  let c = allowed.find(c => normalizeJID(c.phone) === jid);
  if (!c && jid.endsWith('@lid') && sock) {
    try {
      const contacts = sock.store?.contacts || {};
      const resolved = Object.values(contacts).find(ct => ct.lid === jid || ct.id === jid);
      if (resolved?.id) c = allowed.find(ac => normalizeJID(ac.phone) === resolved.id);
    } catch (_) {}
  }
  return c?.name || jid.split('@')[0];
}

// Look up name from receipts (for campaign contacts not in allowed list)
function getNameFromReceipts(jid) {
  const r = Object.values(receipts).find(r => r.jid === jid);
  return r?.name || jid.split('@')[0];
}

async function resolveJIDForSend(jid) {
  if (!jid.endsWith('@lid')) return jid;
  if (sock) {
    try {
      const contacts = sock.store?.contacts || {};
      const resolved = Object.values(contacts).find(c => c.lid === jid || c.id === jid);
      if (resolved?.id?.endsWith('@s.whatsapp.net')) return resolved.id;
    } catch (_) {}
  }
  return jid;
}

function checkDailyReset() {
  const today = new Date().toDateString();
  if (lastSentDate !== today) { dailySentCount = 0; lastSentDate = today; }
}

function randomDelay() {
  return Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN) + DELAY_MIN);
}

function fillTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    row[key] || row[key.toLowerCase()] || `{{${key}}}`
  );
}

function addLog(entry) {
  activityLog.unshift({ ...entry, time: new Date().toISOString() });
  if (activityLog.length > 300) activityLog.pop();
  emit('log_entry', activityLog[0]);
}

// ─── AI Reply Engine ──────────────────────────────────────────────────
async function generateReply(message, contactName, history) {
  const persona = loadPersona();
  const historyText = history.slice(-10)
    .map(h => `${h.role === 'me' ? persona.name : contactName}: ${h.text}`)
    .join('\n');

  const prompt = `You are ${persona.name}.
Your role: ${persona.role}
Your tone: ${persona.tone}
Rules:
${(persona.rules || []).map(r => `- ${r}`).join('\n')}
Business context:
${persona.business_context}
---
Chat history with ${contactName}:
${historyText || '(no previous messages)'}
${contactName}: ${message}
${persona.name} (reply as WhatsApp message, short, natural, human):`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ─── Clean stale sessions ────────────────────────────────────────────
function cleanStaleSessions() {
  try {
    const authDir = path.resolve('auth');
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir);
    const sessionFiles = files.filter(f => f.startsWith('session-') && f.endsWith('.json'));
    const groups = {};
    for (const f of sessionFiles) {
      const match = f.match(/^session-(\d+)\.(\d+)\.json$/);
      if (match) {
        const base = match[1];
        if (!groups[base]) groups[base] = [];
        groups[base].push({ file: f, index: parseInt(match[2]) });
      }
    }
    let cleaned = 0;
    for (const base of Object.keys(groups)) {
      const sorted = groups[base].sort((a, b) => b.index - a.index);
      for (const entry of sorted.slice(1)) {
        fs.unlinkSync(path.join(authDir, entry.file));
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[AUTH] Cleaned ${cleaned} stale session file(s)`);
  } catch (err) {
    console.error('[AUTH] cleanStaleSessions error:', err.message);
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────
async function startWhatsApp() {
  cleanStaleSessions();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  const currentSock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    getMessage: async () => undefined,
    logger: {
      level: 'silent', trace(){}, debug(){}, info(){}, warn(){},
      error(o){ if(o?.err) console.error('[WA]', o.err?.message); },
      fatal(){}, child(){ return this; }
    }
  });

  sock = currentSock;

  currentSock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      connectionStatus = 'qr';
      emit('qr', currentQR);
      emit('status', { status: 'qr' });
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      currentQR = null;
      const user = currentSock.user;
      console.log('✅ WhatsApp connected as', user?.name || user?.id);
      emit('status', { status: 'connected', user: user?.name || user?.id?.split(':')[0] });
      startMessageListener(currentSock);
    }

    if (connection === 'close') {
      if (currentSock !== sock && sock !== null) return;
      connectionStatus = 'disconnected';
      emit('status', { status: 'disconnected' });
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnecting in 3s...');
        sock = null;
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log('Logged out.');
        sock = null;
      }
    }
  });

  currentSock.ev.on('creds.update', saveCreds);
}

// ─── Message Listener ─────────────────────────────────────────────────
function startMessageListener(socketInstance) {
  console.log('[AI] Message listener attached');

  // ── NEW: Track read receipts ─────────────────────────────────────────
  socketInstance.ev.on('message-receipt.update', updates => {
    if (socketInstance !== sock) return;
    for (const { key, receipt } of updates) {
      // receipt.readTimestamp means they actually read it
      if (!receipt.readTimestamp) continue;
      const msgId = key.id;
      if (receipts[msgId]) {
        if (!receipts[msgId].seenAt) {
          receipts[msgId].seenAt = new Date(receipt.readTimestamp * 1000).toISOString();
          saveReceipts(receipts);
          campaignStats.seen++;
          emit('message_seen', { msgId, ...receipts[msgId] });
          emit('campaign_stats', campaignStats);
          addLog({ type: 'seen', name: receipts[msgId].name, phone: receipts[msgId].phone, text: `Seen at ${new Date(receipts[msgId].seenAt).toLocaleTimeString()}` });
          console.log(`[SEEN] ${receipts[msgId].name} read the message`);
        }
      }
    }
  });

  // ── NEW: Also catch status updates for read receipts ────────────────
  socketInstance.ev.on('messages.update', updates => {
    if (socketInstance !== sock) return;
    for (const { key, update } of updates) {
      if (update.status === 4 || update.status === 'READ') { // 4 = READ in Baileys
        const msgId = key.id;
        if (receipts[msgId] && !receipts[msgId].seenAt) {
          receipts[msgId].seenAt = new Date().toISOString();
          saveReceipts(receipts);
          campaignStats.seen++;
          emit('message_seen', { msgId, ...receipts[msgId] });
          emit('campaign_stats', campaignStats);
          addLog({ type: 'seen', name: receipts[msgId].name, phone: receipts[msgId].phone, text: 'Message read ✓✓' });
        }
      }
    }
  });

  // ── Main message handler ──────────────────────────────────────────────
  socketInstance.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (socketInstance !== sock) return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        if (!from || from.includes('@g.us')) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption || '';

        if (!text.trim()) continue;

        console.log(`[MSG] from=${from} text="${text.slice(0,60)}"`);

        const fromPhone = from.replace('@s.whatsapp.net','').replace('@lid','');

        // ── NEW: Check if this is a reply to a campaign message ──────────
        const isCampaignContact = Object.values(receipts).some(r => r.jid === from || r.phone === fromPhone);
        const isAiAllowed       = isAllowed(from);

        if (isCampaignContact || isAiAllowed) {
          const name = isAiAllowed ? getContactName(from) : (getNameFromReceipts(from) || fromPhone);
          const phone = fromPhone;

          // Add to inbox
          const inboxEntry = { id: Date.now(), from, name, text, time: new Date().toISOString() };
          inbox.unshift(inboxEntry);
          if (inbox.length > 500) inbox.pop();
          emit('new_message', inboxEntry);

          // ── NEW: Track as a reply ────────────────────────────────────
          if (isCampaignContact) {
            const existing = replies.find(r => r.jid === from);
            const replyEntry = { role: 'them', text, time: new Date().toISOString() };

            if (existing) {
              existing.thread.push(replyEntry);
              existing.lastText = text;
              existing.lastTime = new Date().toISOString();
              existing.isHotLead = true; // anyone who replied is a hot lead
            } else {
              campaignStats.replied++;
              emit('campaign_stats', campaignStats);
              replies.unshift({
                id: Date.now(), jid: from, name, phone,
                text, time: new Date().toISOString(),
                isHotLead: true,
                thread: [replyEntry]
              });
              if (replies.length > 500) replies.pop();
            }
            saveReplies(replies);
            emit('new_reply', { jid: from, name, phone, text, time: new Date().toISOString(), isHotLead: true });
            addLog({ type: 'reply', name, phone, text: `↩ ${text}` });
          }

          // ── AI Auto-reply (only for allowed numbers) ─────────────────
          if (isAiAllowed) {
            if (!aiEnabled) {
              addLog({ type: 'ignored', name, phone: from.split('@')[0], text, reason: 'AI is OFF' });
              continue;
            }

            const memKey = from;
            if (!conversations[memKey]) conversations[memKey] = [];
            conversations[memKey].push({ role: 'them', text });

            await socketInstance.sendPresenceUpdate('composing', from);
            await sleep(1500 + Math.random() * 2000);

            const reply = await generateReply(text, name, conversations[memKey]);

            conversations[memKey].push({ role: 'me', text: reply });
            if (conversations[memKey].length > 40) conversations[memKey] = conversations[memKey].slice(-40);

            const sendTo = await resolveJIDForSend(from);
            await socketInstance.sendMessage(sendTo, { text: reply });
            await socketInstance.sendPresenceUpdate('paused', from);

            // Track AI reply in thread if also a campaign contact
            if (isCampaignContact) {
              const existing = replies.find(r => r.jid === from);
              if (existing) {
                existing.thread.push({ role: 'me', text: reply, time: new Date().toISOString() });
                saveReplies(replies);
              }
              emit('reply_thread_update', { jid: from, role: 'me', text: reply, time: new Date().toISOString() });
            }

            addLog({ type: 'ai_reply', name, phone: from.split('@')[0], incoming: text, reply });
            emit('ai_replied', { from, name, incoming: text, reply, time: new Date().toISOString() });
          } else {
            // Not in AI allowed list but IS a campaign contact — just log the reply
            if (!isCampaignContact) {
              console.log(`[IGNORED] Not in allowed list: ${from}`);
            }
          }
        } else {
          console.log(`[IGNORED] Unknown contact: ${from}`);
        }

      } catch (err) {
        console.error('[MSG ERROR]', err.message);
        addLog({ type: 'error', text: err.message });
      }
    }
  });
}

// ─── REST API ─────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  checkDailyReset();
  const persona = loadPersona();
  res.json({
    connectionStatus, qr: currentQR, aiEnabled,
    allowedCount: loadAllowed().length,
    inboxCount: inbox.length,
    personaName: persona.name,
    user: sock?.user?.name || sock?.user?.id?.split(':')[0] || null,
    campaignRunning, campaignPaused,
    dailySentCount, dailyLimit: DAILY_LIMIT,
    csvCount: csvContacts.length,
    campaignStats,
    repliesCount: replies.length,
    hotLeads: replies.filter(r => r.isHotLead).length
  });
});

app.post('/api/ai/start', (req, res) => {
  if (connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp not connected' });
  aiEnabled = true;
  emit('ai_status', { enabled: true });
  addLog({ type: 'system', text: 'AI Auto-Reply STARTED' });
  res.json({ aiEnabled: true });
});

app.post('/api/ai/stop', (req, res) => {
  aiEnabled = false;
  emit('ai_status', { enabled: false });
  addLog({ type: 'system', text: 'AI Auto-Reply STOPPED' });
  res.json({ aiEnabled: false });
});

// ── Allowed Numbers ──
app.get('/api/numbers', (req, res) => res.json(loadAllowed()));

app.post('/api/numbers/add', (req, res) => {
  const { name, phone, note } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const list = loadAllowed();
  const jid = normalizeJID(phone);
  if (list.some(c => normalizeJID(c.phone) === jid)) return res.status(400).json({ error: 'Number already added' });
  list.push({ name: name || phone, phone: phone.replace(/\D/g,''), note: note || '' });
  saveAllowed(list);
  emit('numbers_updated', loadAllowed());
  res.json({ success: true, list });
});

app.delete('/api/numbers/:phone', (req, res) => {
  let list = loadAllowed();
  list = list.filter(c => c.phone !== req.params.phone);
  saveAllowed(list);
  emit('numbers_updated', list);
  delete conversations[normalizeJID(req.params.phone)];
  res.json({ success: true });
});

app.post('/api/numbers/:phone/clear-memory', (req, res) => {
  conversations[normalizeJID(req.params.phone)] = [];
  res.json({ success: true });
});

// ── Persona ──
app.get('/api/persona', (req, res) => res.json(loadPersona()));
app.post('/api/persona', (req, res) => {
  const { name, role, tone, rules, business_context } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  savePersona({ name, role, tone, rules: Array.isArray(rules) ? rules : (rules||'').split('\n').filter(Boolean), business_context });
  res.json({ success: true });
});

// ── Inbox / Log ──
app.get('/api/inbox', (req, res) => res.json(inbox.slice(0, 200)));
app.get('/api/log',   (req, res) => res.json(activityLog.slice(0, 200)));

// ── NEW: Replies API ──
app.get('/api/replies', (req, res) => res.json(replies.slice(0, 200)));

app.get('/api/replies/:jid/thread', (req, res) => {
  const r = replies.find(r => r.jid === decodeURIComponent(req.params.jid));
  res.json(r?.thread || []);
});

// ── NEW: Manual send (reply from dashboard) ──
app.post('/api/send', async (req, res) => {
  const { jid, text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'jid and text required' });
  if (connectionStatus !== 'connected') return res.status(400).json({ error: 'Not connected' });
  try {
    const sendTo = await resolveJIDForSend(jid);
    const sentMsg = await sock.sendMessage(sendTo, { text });
    // Track in thread
    const r = replies.find(r => r.jid === jid);
    const entry = { role: 'me', text, time: new Date().toISOString() };
    if (r) {
      r.thread.push(entry);
      saveReplies(replies);
      emit('reply_thread_update', { jid, ...entry });
    }
    addLog({ type: 'manual_send', name: getNameFromReceipts(jid) || jid.split('@')[0], phone: jid.split('@')[0], text: `✉ ${text}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NEW: Campaign stats ──
app.get('/api/campaign/stats', (req, res) => res.json(campaignStats));

// ── NEW: Receipts (seen data) ──
app.get('/api/receipts', (req, res) => {
  const list = Object.values(receipts).filter(r => r.seenAt).sort((a,b) => new Date(b.seenAt) - new Date(a.seenAt));
  res.json(list.slice(0, 200));
});

// ── Disconnect ──
app.post('/api/disconnect', async (req, res) => {
  try {
    aiEnabled = false;
    if (sock) await sock.logout().catch(() => {});
    fs.rmSync('auth', { recursive: true, force: true });
    fs.mkdirSync('auth', { recursive: true });
    connectionStatus = 'disconnected';
    sock = null;
    emit('status', { status: 'disconnected' });
    setTimeout(startWhatsApp, 1000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign Engine ──────────────────────────────────────────────────
async function runCampaign({ template }) {
  if (connectionStatus !== 'connected') { emit('campaign_error', 'WhatsApp not connected'); return; }
  if (campaignRunning)                  { emit('campaign_error', 'Campaign already running'); return; }
  if (!csvContacts.length)              { emit('campaign_error', 'No contacts loaded'); return; }

  campaignRunning = true;
  campaignAbort   = false;
  campaignPaused  = false;

  // Reset stats for new campaign run
  campaignStats = { total: csvContacts.length, sent: 0, seen: 0, replied: 0 };
  emit('campaign_started', { total: csvContacts.length });
  emit('campaign_stats', campaignStats);

  for (let i = 0; i < csvContacts.length; i++) {
    if (campaignAbort) break;
    while (campaignPaused) { await sleep(1000); if (campaignAbort) break; }
    if (campaignAbort) break;

    checkDailyReset();
    if (dailySentCount >= DAILY_LIMIT) {
      emit('campaign_done', { sent: dailySentCount, total: csvContacts.length, reason: 'Daily limit reached' });
      campaignRunning = false;
      return;
    }

    const row   = csvContacts[i];
    const phone = (row.phone || row.number || row.Phone || row.Number || '').toString().trim();
    if (!phone) {
      emit('campaign_log', { index: i, name: row.name || row.Name || '?', phone: '', status: 'skipped', reason: 'No phone', time: new Date().toISOString() });
      continue;
    }

    const cleanedPhone = cleanPhone(phone);
    const jid          = cleanedPhone + '@s.whatsapp.net';
    const name         = row.name || row.Name || phone;
    const message      = fillTemplate(template, row);

    try {
      const [result] = await sock.onWhatsApp(cleanedPhone);
      if (!result?.exists) {
        emit('campaign_log', { index: i, name, phone, status: 'skipped', reason: 'Not on WhatsApp', time: new Date().toISOString() });
        emit('campaign_progress', { current: i + 1, total: csvContacts.length, sent: dailySentCount });
        continue;
      }

      const targetJid = result.jid || jid;

      // ── NEW: Send with message ID so we can track reads ────────────
      const sent = await sock.sendMessage(targetJid, { text: message });
      const msgId = sent?.key?.id;

      dailySentCount++;
      campaignStats.sent++;

      // ── NEW: Register receipt tracker ────────────────────────────
      if (msgId) {
        receipts[msgId] = {
          msgId, jid: targetJid, name, phone: cleanedPhone,
          sentAt: new Date().toISOString(), text: message.slice(0, 100),
          seenAt: null
        };
        saveReceipts(receipts);
      }

      emit('campaign_log', { index: i, name, phone, status: 'sent', preview: message.slice(0, 80), msgId, time: new Date().toISOString() });
      emit('campaign_progress', { current: i + 1, total: csvContacts.length, sent: dailySentCount });
      emit('campaign_stats', campaignStats);

      const delay = randomDelay();
      emit('campaign_next_in', { ms: delay });
      await sleep(delay);

    } catch (err) {
      emit('campaign_log', { index: i, name, phone, status: 'failed', reason: err.message, time: new Date().toISOString() });
      await sleep(3000);
    }
  }

  campaignRunning = false;
  if (!campaignAbort) emit('campaign_done', { sent: dailySentCount, total: csvContacts.length });
  else                emit('campaign_stopped', { sent: dailySentCount });
}

// ─── Campaign API ─────────────────────────────────────────────────────
app.post('/api/csv/upload', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
    .on('data', row => results.push(row))
    .on('end', () => {
      csvContacts = results;
      const columns = results.length ? Object.keys(results[0]) : [];
      res.json({ count: results.length, columns, preview: results.slice(0, 3) });
      emit('csv_loaded', { count: results.length, columns });
    })
    .on('error', err => res.status(500).json({ error: err.message }));
});

app.get('/api/csv/contacts', (req, res) => res.json({ count: csvContacts.length, columns: csvContacts.length ? Object.keys(csvContacts[0]) : [], preview: csvContacts.slice(0, 5) }));

app.post('/api/campaign/start', (req, res) => {
  const { template } = req.body;
  if (!template) return res.status(400).json({ error: 'Template required' });
  runCampaign({ template });
  res.json({ started: true });
});

app.post('/api/campaign/pause', (req, res) => {
  campaignPaused = !campaignPaused;
  emit('campaign_paused_toggle', campaignPaused);
  res.json({ paused: campaignPaused });
});

app.post('/api/campaign/stop', (req, res) => {
  campaignAbort   = true;
  campaignRunning = false;
  res.json({ stopped: true });
});

app.get('/api/campaign/status', (req, res) => {
  checkDailyReset();
  res.json({ campaignRunning, campaignPaused, dailySentCount, dailyLimit: DAILY_LIMIT, csvCount: csvContacts.length, campaignStats });
});

// ─── Socket.io ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const persona = loadPersona();
  socket.emit('status',          { status: connectionStatus, user: sock?.user?.name || null });
  socket.emit('ai_status',       { enabled: aiEnabled });
  if (currentQR) socket.emit('qr', currentQR);
  socket.emit('numbers_updated', loadAllowed());
  socket.emit('inbox_init',      inbox.slice(0, 100));
  socket.emit('log_init',        activityLog.slice(0, 100));
  socket.emit('persona_loaded',  persona);
  socket.emit('replies_init',    replies.slice(0, 100));
  checkDailyReset();
  socket.emit('campaign_status', { campaignRunning, campaignPaused, dailySentCount, dailyLimit: DAILY_LIMIT, csvCount: csvContacts.length });
  socket.emit('campaign_stats',  campaignStats);
});

// ─── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WA AI Dashboard → http://localhost:${PORT}\n`);
  startWhatsApp();
});
