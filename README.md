# Stock Analyser

AI-powered stock scoring tool for long-term (5-year+) investors. Scores any stock or commodity across 11 weighted factors and produces a written synopsis per factor plus a final investability score out of 10.

## Project structure

```
stock-analyser/
├── server.js          # Node HTTP server — handles API calls and static serving
├── package.json
├── .env               # Your real keys — never commit this
├── .env.example       # Template — commit this instead
├── .gitignore
├── README.md
└── public/
    ├── index.html     # HTML template only — no inline CSS or JS
    ├── css/
    │   └── styles.css
    └── js/
        └── app.js
```

## Setup

**1. Copy the env template and add your key(s)**

```bash
cp .env.example .env
```

Open `.env` and fill in at least one of:

```
ANTHROPIC_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
```

**2. Start the server**

```bash
node server.js
# or, with auto-restart on file changes (Node 18+):
node --watch server.js
```

**3. Open the app**

```
http://127.0.0.1:3000
```

## Provider selection

The server auto-detects which provider to use based on which key is set. If both are set, Anthropic is preferred. You can force a provider:

```bash
# In .env
AI_PROVIDER=openai
```

## Model overrides

```bash
# In .env
ANTHROPIC_MODEL=claude-sonnet-4-20250514
OPENAI_MODEL=gpt-4.1
```

## How scoring works

| Layer | Factors | Weight |
|---|---|---|
| 1 — Business quality | Moat (20), Business (15), Industry (5), Management (5) | 45% |
| 2 — Financial health | FCF (15), Profitability (10), Debt (5), Growth (5) | 35% |
| 3 — Valuation | Intrinsic value (10), P/E & P/B (5), Earnings yield (3), Peers (2) | 20% |

Each factor is scored 0–100, then converted to its weighted contribution. Final score is out of 10.

## API

`POST /api/analyse`

```json
{ "stock": "Infosys" }
```

Returns the full JSON scorecard. Useful if you want to build your own frontend or automate batch analysis.

`GET /health` — returns `{ "ok": true, "provider": "anthropic" }`

## Disclaimer

This tool uses AI-generated research from public sources. Not financial advice. Always do your own due diligence.
