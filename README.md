# lay-rail

Deploys a Hello World Express app to Railway using only the GitHub and Railway APIs — no CLIs, no SDKs, just Node.js `fetch`.

## What it does

1. Checks if the target GitHub repo exists; creates it if not
2. Uploads `app/` files to the repo via the GitHub Contents API
3. Creates a Railway project in your workspace
4. Creates a service linked to the GitHub repo
5. Triggers a deployment and polls until it succeeds
6. Reads the runtime port from deployment logs
7. Generates a public `*.up.railway.app` domain pointed at the correct port

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- A GitHub account with a **Classic PAT** (`repo` scope)
- A Railway account with an **account-level token**

## Setup

```bash
cp .env.sample .env
# fill in your values
```

| Variable | Required | Description |
|---|---|---|
| `GITHUB_USER` | Yes | Your GitHub username |
| `GITHUB_TOKEN` | Yes | Classic PAT with `repo` scope |
| `RAILWAY_TOKEN` | Yes | Account-level token from Railway → Account → Tokens |
| `REPO_NAME` | No | Target repo name (default: `hello-express`) |
| `RAILWAY_PROJECT_NAME` | No | Railway project name (default: `hello-express-app`) |

## Run

```bash
node deploy.js
```

Output looks like:

```
▶ Step 1: Checking GitHub repo you/hello-express-railway...
  ✓ Repo already exists — skipping creation.

▶ Step 2: Uploading app files to GitHub...
  ✓ Uploaded index.js
  ✓ Uploaded package.json
  ✓ Uploaded .gitignore

▶ Step 3: Fetching Railway workspace ID...
  ✓ Workspace: Your Workspace (abc-123)

▶ Step 4: Creating Railway project 'hello-express-app'...
  ✓ Project ID: f9cf61b9-...

▶ Step 5: Fetching Railway environment ID...
  ✓ Environment ID: b2a1c6c6-...

▶ Step 6: Creating Railway service from GitHub repo...
  ✓ Service ID: 817e1b68-...

▶ Step 7: Triggering deployment from latest commit...
  Status: BUILDING
  Status: SUCCESS

▶ Step 8: Reading runtime port from logs...
  ✓ App is listening on port 8080

▶ Step 9: Creating public domain...
  ✓ Domain: https://web-production-xxxx.up.railway.app

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Done!
  App      : https://web-production-xxxx.up.railway.app
  Dashboard: https://railway.app/project/f9cf61b9-...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## App

The deployed app lives in `app/` — a minimal Express server that responds at `/` and `/health`.

```
GET /        → { message, environment, timestamp }
GET /health  → { status: "ok" }
```

Railway injects a `PORT` environment variable at runtime; the app listens on that.

## Project structure

```
lay-rail/
├── deploy.js        ← the deploy script
├── package.json
├── .env.sample      ← copy to .env and fill in
└── app/
    ├── index.js
    ├── package.json
    └── .gitignore
```
