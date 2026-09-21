# IdeaBox Arena — Month 3 Week 4 Practical Week
A zero-dependency Node.js app. Serves the Arena UI from `public/`, stores all
state in `data/*.json` (a small folder that persists between requests), and
grades submissions by calling three OpenAI-compatible providers.

## Run locally
```
node server.js          # reads .env for PORT / API keys, defaults to port 3100
```

## Deploy on Render (Blueprint)
The `render.yaml` at the root is a Render Blueprint. On Render:

1. **New → Blueprint** → point at this repo.
2. Set the secrets in the Blueprint's service (Environment → Environment Variables):
   - `PORT` (Render injects its own; use 10000)
   - `INSTRUCTOR_PIN` — the console PIN (default 1234)
   - `MISTRAL_API_KEY` / `MISTRAL_MODEL`
   - `NARAROUTER_API_KEY` / `NARAROUTER_MODEL`
   - `UNOROUTER_API_KEY` / `UNOROUTER_MODEL`
   - `LEADERBOARD_MODE` — growth | podium | full
3. Deploy. The app answers on port 10000; Render proxies it to your
   `*.onrender.com` URL.

## Data persistence note
Render's free "web" services have ephemeral filesystem EXCEPT that a restarted
service keeps the latest deploy's disk; free services also sleep after 15 min
idle and cold-start on the next request. `data/` includes a clean
`state.json` — all submissions/grades save there, exactly as on a laptop.
