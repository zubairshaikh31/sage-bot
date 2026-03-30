# Sage Chatbot — Setup Guide

## Required Environment Variables

### Backend (Render)
| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | ✅ Yes | Get free key at https://console.groq.com |
| `PORT` | Auto | Render sets this automatically |
| `NODE_ENV` | Optional | Set to `production` on Render |
| `ALLOWED_ORIGINS` | Optional | Comma-separated allowed origins (e.g. `https://your-app.vercel.app`) |

### Frontend (Vercel)
| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | ✅ Yes (production) | Your Render backend URL + `/api` (e.g. `https://sage-backend.onrender.com/api`) |

---

## Local Development

### 1. Backend
```bash
cd backend
npm install
cp .env.example .env
# Add your GROQ_API_KEY to .env
npm run dev
```

### 2. Frontend
```bash
cd frontend
npm install
# No .env needed locally — Vite proxy handles /api → localhost:3001
npm run dev
```

Open http://localhost:5173

---

## Deployment

### Backend → Render
1. Create a new **Web Service** on Render
2. Connect your GitHub repo, set **Root Directory** to `backend`
3. **Build Command:** `npm install`
4. **Start Command:** `node server.js`
5. Add environment variable: `GROQ_API_KEY=your_key_here`
6. Copy the deployed URL (e.g. `https://sage-backend.onrender.com`)

### Frontend → Vercel
1. Import your repo on Vercel, set **Root Directory** to `frontend`
2. Add environment variable: `VITE_API_URL=https://sage-backend.onrender.com/api`
3. Deploy — Vercel auto-detects Vite

---

## Model Used
- **Groq model:** `llama3-8b-8192`
- **API:** OpenAI-compatible via `https://api.groq.com/openai/v1`
