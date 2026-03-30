// ── Config ────────────────────────────────────────────────────────────────────
// VITE_API_URL must be set in Vercel environment variables:
//   VITE_API_URL = https://sage-bot-vihu.onrender.com/api
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// ── State ─────────────────────────────────────────────────────────────────────
let sessionId = null;
let currentMood = null;
let isStreaming = false;
let goals = [];
let moodLog = [];

// ── Wake up Render backend (free tier sleeps after 15min inactivity) ──────────
async function pingBackend() {
  try {
    await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(8000) });
  } catch (_) {
    // silent — just a warm-up ping
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Ping backend first to wake it up from Render's sleep
  pingBackend();

  try {
    const stored = localStorage.getItem("sage_session");
    const res = await fetch(`${API_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: stored }),
    });

    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    const data = await res.json();
    sessionId = data.sessionId;
    localStorage.setItem("sage_session", sessionId);
    document.getElementById("session-display").textContent = `ID: ${sessionId.slice(0, 8)}…`;

    if (data.resumed) {
      await loadSession();
    } else {
      showWelcome();
    }
    renderJournalPrompts();
  } catch (err) {
    console.error("Init error:", err);
    appendBotMsg(
      "I'm having trouble connecting right now. The server may be waking up — please wait a moment and **refresh the page** to try again."
    );
  }
}

async function loadSession() {
  try {
    const res = await fetch(`${API_BASE}/session/${sessionId}`);
    if (!res.ok) { showWelcome(); return; }
    const data = await res.json();
    data.messages.forEach(m => m.role === "user" ? appendUserMsg(m.content) : appendBotMsg(m.content));
    goals = data.goals || [];
    moodLog = data.moodLog || [];
    renderGoals();
    renderMoodLog();
  } catch (err) {
    console.error("Load session error:", err);
    showWelcome();
  }
}

// ── Session ───────────────────────────────────────────────────────────────────
function showWelcome() {
  appendBotMsg(
    `Hey there! I'm **Sage** 🌿 — your personal reflection companion.\n\nThis is a safe, judgment-free space just for you. Whether you want to vent, explore your feelings, set a goal, or just breathe for a moment — I'm here for all of it.\n\nHow are you feeling right now? Tap a mood above, pick a prompt, or just start typing.`
  );
}

// ── Tab navigation ────────────────────────────────────────────────────────────
window.showTab = function (tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn, .mob-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.getElementById(`tab-${tab}`).classList.add("active");
  if (tab === "goals") renderGoals();
  if (tab === "mood") renderMoodLog();
};

// ── Mood ──────────────────────────────────────────────────────────────────────
const MOOD_ICONS = { Happy:"😊", Anxious:"😰", Tired:"😴", Motivated:"🔥", Sad:"😔", Grateful:"🙏", Overwhelmed:"😵", Calm:"🌊" };
const MOOD_COLORS = { Happy:"#f5c518", Anxious:"#e67e22", Tired:"#9b59b6", Motivated:"#e74c3c", Sad:"#3498db", Grateful:"#27ae60", Overwhelmed:"#e74c3c", Calm:"#1abc9c" };

window.selectMood = function (el) {
  document.querySelectorAll(".mood-chip").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
  currentMood = el.dataset.mood;
  const input = document.getElementById("msg-input");
  input.value = `I'm feeling ${currentMood.toLowerCase()} today.`;
  input.focus();
  autoResize(input);
};

window.injectPrompt = function (text) {
  const input = document.getElementById("msg-input");
  input.value = text;
  input.focus();
  autoResize(input);
};

// ── Send message ──────────────────────────────────────────────────────────────
window.sendMessage = async function () {
  if (isStreaming) return;
  const input = document.getElementById("msg-input");
  const text = input.value.trim();
  if (!text) return;

  const moodToSend = currentMood; // capture before clearing

  input.value = "";
  autoResize(input);
  appendUserMsg(text);

  if (moodToSend) {
    moodLog.unshift({ mood: moodToSend, timestamp: new Date().toISOString() });
    document.querySelectorAll(".mood-chip").forEach(c => c.classList.remove("selected"));
    currentMood = null;
  }

  isStreaming = true;
  document.getElementById("send-btn").disabled = true;
  const typingEl = showTyping();

  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text, mood: moodToSend }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let replyEl = null;
    typingEl.remove();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop(); // keep incomplete chunk

      for (const line of lines) {
        // Skip SSE comments (ping / keep-alive lines starting with ":")
        if (!line.startsWith("data: ")) continue;

        let payload;
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }

        if (payload.type === "delta") {
          if (!replyEl) replyEl = createStreamingBubble();
          replyEl.dataset.raw = (replyEl.dataset.raw || "") + payload.text;
          replyEl.innerHTML = renderMarkdown(replyEl.dataset.raw);
          scrollToBottom();
        }

        if (payload.type === "done") {
          // Stream finished cleanly — nothing extra needed
        }

        if (payload.type === "error") {
          if (replyEl) replyEl.textContent = payload.message;
          else appendBotMsg(payload.message);
        }
      }
    }

    // Edge case: stream ended but no reply element (empty response)
    if (!replyEl) appendBotMsg("I didn't get a response — please try again.");

  } catch (err) {
    console.error("Send error:", err);
    typingEl?.remove();
    appendBotMsg("I'm here with you. Something went wrong on my end — could you try again?");
  }

  isStreaming = false;
  document.getElementById("send-btn").disabled = false;
};

// ── Rendering ─────────────────────────────────────────────────────────────────
function appendUserMsg(text) {
  const area = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `
    <div class="msg-avatar">✦</div>
    <div class="msg-content">
      <div class="msg-bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
      <div class="msg-time">${getTime()}</div>
    </div>`;
  area.appendChild(div);
  scrollToBottom();
}

function appendBotMsg(text) {
  const area = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg bot";
  div.innerHTML = `
    <div class="msg-avatar">🌿</div>
    <div class="msg-content">
      <div class="msg-bubble">${renderMarkdown(text)}</div>
      <div class="msg-time">${getTime()}</div>
    </div>`;
  area.appendChild(div);
  scrollToBottom();
}

function createStreamingBubble() {
  const area = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg bot";
  div.innerHTML = `
    <div class="msg-avatar">🌿</div>
    <div class="msg-content">
      <div class="msg-bubble streaming-bubble"></div>
      <div class="msg-time">${getTime()}</div>
    </div>`;
  area.appendChild(div);
  scrollToBottom();
  return div.querySelector(".streaming-bubble");
}

function showTyping() {
  const area = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "typing";
  div.innerHTML = `<div class="msg-avatar" style="background:linear-gradient(135deg,#4a7c5e,#7dab8e);font-size:15px;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;">🌿</div><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
  area.appendChild(div);
  scrollToBottom();
  return div;
}

// ── Goals ─────────────────────────────────────────────────────────────────────
window.addGoal = async function () {
  const input = document.getElementById("goal-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    const res = await fetch(`${API_BASE}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, goal: text }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.goal) { goals.unshift(data.goal); renderGoals(); }
  } catch { console.error("Add goal failed"); }
};

async function toggleGoal(id) {
  try {
    const res = await fetch(`${API_BASE}/goals/${id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.goal) {
      const idx = goals.findIndex(g => g.id === id);
      if (idx !== -1) goals[idx] = data.goal;
      renderGoals();
    }
  } catch { console.error("Toggle goal failed"); }
}

function deleteGoal(id) {
  goals = goals.filter(g => g.id !== id);
  renderGoals();
}

function renderGoals() {
  const list = document.getElementById("goal-list");
  const empty = document.getElementById("goals-empty");
  list.innerHTML = "";
  if (goals.length === 0) { empty.style.display = "flex"; return; }
  empty.style.display = "none";
  goals.forEach(g => {
    const li = document.createElement("li");
    li.className = "goal-item";
    const date = new Date(g.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    li.innerHTML = `
      <div class="goal-checkbox ${g.completed ? "done" : ""}" onclick="toggleGoal('${g.id}')"></div>
      <span class="goal-text ${g.completed ? "done" : ""}">${escapeHtml(g.text)}</span>
      <span class="goal-date">${date}</span>
      <button class="goal-delete" onclick="deleteGoal('${g.id}')" title="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    list.appendChild(li);
  });
}

// ── Mood log ──────────────────────────────────────────────────────────────────
function renderMoodLog() {
  const container = document.getElementById("mood-log-list");
  const empty = document.getElementById("mood-empty");
  container.innerHTML = "";
  if (moodLog.length === 0) { empty.style.display = "flex"; return; }
  empty.style.display = "none";
  moodLog.forEach(entry => {
    const div = document.createElement("div");
    div.className = "mood-entry";
    const icon = MOOD_ICONS[entry.mood] || "😶";
    const color = MOOD_COLORS[entry.mood] || "#888";
    const time = new Date(entry.timestamp).toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    div.innerHTML = `
      <div class="mood-entry-icon">${icon}</div>
      <div class="mood-entry-info">
        <div class="mood-entry-name">${entry.mood}</div>
        <div class="mood-entry-time">${time}</div>
      </div>
      <div class="mood-entry-dot" style="background:${color}"></div>`;
    container.appendChild(div);
  });
}

// ── Journal prompts ───────────────────────────────────────────────────────────
const JOURNAL_PROMPTS = [
  { category: "Self-awareness", prompt: "What emotion has been most present for you today, and where do you feel it in your body?" },
  { category: "Reflection",     prompt: "What's one thing you did this week that you're genuinely proud of?" },
  { category: "Growth",         prompt: "What's a limiting belief you've been holding onto? Where did it come from?" },
  { category: "Gratitude",      prompt: "Name three small things that brought you comfort or joy recently." },
  { category: "Goals",          prompt: "What does your ideal version of yourself look like one year from now?" },
  { category: "Relationships",  prompt: "Who in your life makes you feel most like yourself? What do they bring out in you?" },
  { category: "Mindfulness",    prompt: "Right now, in this moment — what do you notice? Sights, sounds, sensations?" },
  { category: "Courage",        prompt: "What's something you've been wanting to say or do, but haven't allowed yourself yet?" },
  { category: "Boundaries",     prompt: "Where in your life do you feel your energy being drained? What boundary might help?" },
  { category: "Purpose",        prompt: "What activities make you lose track of time? What does that tell you about your values?" },
  { category: "Acceptance",     prompt: "What's something you've been resisting? What would happen if you just let it be?" },
  { category: "Strengths",      prompt: "What do people consistently come to you for help with? Why do you think that is?" },
];

function renderJournalPrompts() {
  const grid = document.getElementById("journal-grid");
  grid.innerHTML = "";
  JOURNAL_PROMPTS.forEach(p => {
    const card = document.createElement("div");
    card.className = "journal-card";
    card.innerHTML = `
      <div class="journal-card-category">${p.category}</div>
      <div class="journal-card-prompt">${p.prompt}</div>
      <div class="journal-card-action">Reflect on this →</div>`;
    card.onclick = () => { showTab("chat"); injectPrompt(`I'd like to reflect on this: "${p.prompt}"`); };
    grid.appendChild(card);
  });
}

// ── Clear history ─────────────────────────────────────────────────────────────
window.clearHistory = async function () {
  if (!confirm("Clear the chat history? Your goals and mood log will be kept.")) return;
  try {
    await fetch(`${API_BASE}/session/${sessionId}/messages`, { method: "DELETE" });
    document.getElementById("messages").innerHTML = "";
    showWelcome();
  } catch { console.error("Clear history failed"); }
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/^/, "<p>").replace(/$/, "</p>")
    .replace(/<p><\/p>/g, "");
}
function escapeHtml(t) { return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function getTime() { return new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
function scrollToBottom() { const a = document.getElementById("messages"); a.scrollTop = a.scrollHeight; }

window.autoResize = function (el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 130) + "px";
};
window.handleKey = function (e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
};

window.toggleGoal = toggleGoal;
window.deleteGoal = deleteGoal;

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
