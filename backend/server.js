require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "missing-key",
  baseURL: "https://api.groq.com/openai/v1",
});

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

// CORS — allow everything (no ALLOWED_ORIGINS restriction)
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json({ limit: "10kb" }));
app.use("/api/", rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many requests." } }));

const SYSTEM_PROMPT = `You are Sage, a warm, motivational and uplifting self-reflection companion. Your role is to support humans in four key areas:

1. EMOTIONAL SUPPORT & VENTING — Listen first, validate always. Reflect feelings back without judgment.
2. GUIDED SELF-REFLECTION JOURNALING — Ask one thoughtful open-ended question at a time.
3. MINDFULNESS & STRESS RELIEF — Offer breathing exercises, grounding techniques, body scans.
4. GOAL SETTING & ACCOUNTABILITY — Help users clarify goals. Celebrate progress warmly.

TONE: Warm, motivational, uplifting. Never clinical or preachy.
STYLE: Short paragraphs (2-4 max). ONE question per response. Natural human language.
SAFETY: If self-harm is mentioned, direct to 988 Suicide & Crisis Lifeline and stay present.`;

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size, groqKeySet: !!process.env.GROQ_API_KEY });
});

app.post("/api/session", (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (sessionId) {
      const s = getSession(sessionId);
      if (s) return res.json({ sessionId: s.id, resumed: true });
    }
    res.json({ sessionId: createSession().id, resumed: false });
  } catch (e) {
    console.error("Session error:", e.message);
    res.status(500).json({ error: "Failed to create session." });
  }
});

app.get("/api/session/:id", (req, res) => {
   s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found or expired." });
  res.json({ messages: s.messages, moodLog: s.moodLog, goals: s.goals, createdAt: s.createdAt });
});

// ── Simple non-streaming chat endpoint ────────────────────────────────────────
// No SSE, no buffering issues, no keep-alive complexity.
// Returns plain JSON: { reply: "..." }
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, mood } = req.body || {};

  if (!sessionId || !message?.trim()) {
    return res.status(400).json({ error: "sessionId and message are required." });
  }

  let session = getSession(sessionId);
  if (!session) {
    // Auto-create a new session instead of rejecting
    session = createSession();
    console.log("Session expired, created new:", session.id);
  }

  if (mood) session.moodLog.push({ mood, timestamp: new Date().toISOString() });
  session.messages.push({ role: "user", content: message.trim() });

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",,
      max_tokens: 800,
      stream: false,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages],
    });

    const reply = completion.choices?.[0]?.message?.content || "";
    session.messages.push({ role: "assistant", content: reply });

    res.json({ reply, sessionId: session.id });
  } catch (err) {
    console.error("Groq error:", err.status, err.message);
    session.messages.pop(); // remove failed user message

    let errorMsg = "Something went wrong. Please try again.";
    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === "missing-key") {
      errorMsg = "GROQ_API_KEY is not configured on the server.";
    } else if (err.status === 401) {
      errorMsg = "Invalid GROQ_API_KEY on server.";
    } else if (err.status === 429) {
      errorMsg = "Rate limit hit — please wait a moment and try again.";
    }

    res.status(500).json({ error: errorMsg });
  }
});

app.post("/api/goals", (req, res) => {
  try {
    const { sessionId, goal } = req.body || {};
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
    const s = getSession(req.body?.sessionId);
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
