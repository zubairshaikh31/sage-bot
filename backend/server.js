require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Groq client ──────────────────────────────────────────────────────────────
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "missing-key",
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastActivity > SESSION_TTL_MS) { sessions.delete(id); return null; }
  s.lastActivity = Date.now();
  return s;
}
function createSession() {
  const id = uuidv4();
  sessions.set(id, { id, messages: [], moodLog: [], goals: [], createdAt: Date.now(), lastActivity: Date.now() });
  return sessions.get(id);
}

// ─── CORS — allow ALL origins (tighten via ALLOWED_ORIGINS env var) ───────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
      : null;
    if (!allowed || allowed.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin not allowed"));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
}));
app.options("*", cors()); // preflight

app.use(express.json({ limit: "10kb" }));
app.use("/api/", rateLimit({ windowMs: 60000, max: 30, message: { error: "Too many requests." } }));

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sage, a warm, motivational and uplifting self-reflection companion. Your role is to support humans in four key areas:

1. EMOTIONAL SUPPORT & VENTING — Listen first, validate always. Reflect feelings back without judgment.
2. GUIDED SELF-REFLECTION JOURNALING — Ask one thoughtful open-ended question at a time.
3. MINDFULNESS & STRESS RELIEF — Offer breathing exercises, grounding techniques, body scans.
4. GOAL SETTING & ACCOUNTABILITY — Help users clarify goals. Celebrate progress warmly.

TONE: Warm, motivational, uplifting. Never clinical or preachy.
STYLE: Short paragraphs (2-4 max). ONE question per response. Natural human language.
SAFETY: If self-harm is mentioned, direct to 988 Suicide & Crisis Lifeline and stay present.`;

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", sessions: sessions.size }));

app.post("/api/session", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (sessionId) {
      const s = getSession(sessionId);
      if (s) return res.json({ sessionId: s.id, resumed: true });
    }
    res.json({ sessionId: createSession().id, resumed: false });
  } catch (e) { res.status(500).json({ error: "Failed to create session." }); }
});

app.get("/api/session/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found or expired." });
  res.json({ messages: s.messages, moodLog: s.moodLog, goals: s.goals, createdAt: s.createdAt });
});

// ── Chat — SSE with anti-buffering headers ────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, mood } = req.body;
  if (!sessionId || !message?.trim())
    return res.status(400).json({ error: "sessionId and message are required." });

  const session = getSession(sessionId);
  if (!session)
    return res.status(404).json({ error: "Session expired. Please refresh." });

  if (mood) session.moodLog.push({ mood, timestamp: new Date().toISOString() });
  session.messages.push({ role: "user", content: message.trim() });

  // Critical headers to defeat Render/Nginx response buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");   // tells Nginx: do NOT buffer
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();

  // Immediate ping so browser sees the connection open right away
  res.write(": ping\n\n");
  if (res.flush) res.flush();

  // Keep-alive every 15s to prevent Render's 30s idle timeout
  const keepAlive = setInterval(() => {
    try { res.write(": keep-alive\n\n"); if (res.flush) res.flush(); } catch (_) {}
  }, 15000);

  let fullReply = "";
  try {
    const stream = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      max_tokens: 800,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages],
    });

    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        fullReply += text;
        res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
        if (res.flush) res.flush();
      }
    }

    session.messages.push({ role: "assistant", content: fullReply });
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    if (res.flush) res.flush();
    res.end();
  } catch (err) {
    console.error("Groq error:", err.message);
    session.messages.pop();
    res.write(`data: ${JSON.stringify({ type: "error", message: "Something went wrong. Please try again." })}\n\n`);
    if (res.flush) res.flush();
    res.end();
  } finally {
    clearInterval(keepAlive);
  }
});

app.post("/api/goals", (req, res) => {
  try {
    const { sessionId, goal } = req.body;
    if (!sessionId || !goal?.trim()) return res.status(400).json({ error: "sessionId and goal required." });
    const s = getSession(sessionId);
    if (!s) return res.status(404).json({ error: "Session not found." });
    const entry = { id: uuidv4(), text: goal.trim(), createdAt: new Date().toISOString(), completed: false };
    s.goals.push(entry);
    res.json({ goal: entry });
  } catch (e) { res.status(500).json({ error: "Failed to add goal." }); }
});

app.post("/api/goals/:goalId/toggle", (req, res) => {
  try {
    const s = getSession(req.body.sessionId);
    if (!s) return res.status(404).json({ error: "Session not found." });
    const goal = s.goals.find(g => g.id === req.params.goalId);
    if (!goal) return res.status(404).json({ error: "Goal not found." });
    goal.completed = !goal.completed;
    res.json({ goal });
  } catch (e) { res.status(500).json({ error: "Failed to toggle." }); }
});

app.delete("/api/session/:id/messages", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found." });
  s.messages = [];
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🌿 Sage backend on port ${PORT}`));
