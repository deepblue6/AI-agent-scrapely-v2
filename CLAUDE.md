# AI Setter Agent for Scrapely

## What This Project Is

This is an AI-powered sales assistant that runs 24/7 and automatically replies to Twitter DM leads through Scrapely. When a lead responds to an outbound DM, this agent generates a natural, human-like reply using Claude (through OpenRouter) and sends it back — with the goal of booking a sales call.

It also follows up automatically if leads go quiet (day 2 and day 7).

It runs on **Cloudflare Workers** (free plan is enough). There's no server to manage.

## Project Structure

```
src/index.js         — Worker entry point: webhook, /health, /test, hourly cron, Durable Objects.
src/agent.js         — Scrapely API calls, reply + follow-up generation.
src/openrouter.js    — Calls Claude through OpenRouter (with retries + model fallback).
src/instructions.md  — PERSONALITY FILE. Controls how the AI talks (tone, style, flow).
src/offer.md         — CONTEXT FILE. Your product, results, testimonials, pricing info.
wrangler.jsonc       — Cloudflare config. Don't change unless you know why.
.env                 — YOUR API KEYS GO HERE. Never commit this file.
.dev.vars.example    — Template showing what keys you need (also read by the Deploy button).
```

## How to Set This Up for the User

Do as much as possible yourself. The user only has to: log in to Cloudflare once in the browser, give you their keys, answer questions about their offer, and paste two values in the Scrapely dashboard. Go through these steps in order. Don't expect them to know what an API key is.

### Step 1: Install dependencies

Run `npm install`.

### Step 2: Collect the keys and create `.env`

Run `cp .dev.vars.example .env`, then ask the user for each value and write it into `.env` yourself.

**OPENROUTER_API_KEY** — powers the AI replies.
- Ask: "Do you have an OpenRouter account? If not, sign up at https://openrouter.ai."
- They need to add credits (https://openrouter.ai/settings/credits), then create a key (https://openrouter.ai/settings/keys).
- The key starts with `sk-or-`.

**SCRAPELY_API_KEY**
- Ask: "Go to your Scrapely dashboard → Settings → API Keys → Create Key, and paste it here."

**CALENDAR_LINK**
- Ask: "What's your calendar booking link? (Calendly, Cal.com, etc.)"

**WEBHOOK_SECRETS** — leave the placeholder for now. You'll fill it in at Step 6, after the Worker has a URL.

### Step 3: Customize the AI

**src/offer.md** — WHAT the AI knows about their business. THIS FILE MUST BE FILLED IN.
- Show them `src/offer.example.md` as a reference.
- Ask these and write the file from their answers:
  1. "What's your company name?"
  2. "What do you do / what do you sell? Explain it like you're telling a friend."
  3. "Any results or testimonials from past clients? Rough numbers are great, like '12 calls booked in 2 weeks'."
  4. "What does your service include?"
  5. "How does the process work after they book a call?"
  6. "What's the pricing range? The AI needs this to answer price questions without dodging."
  7. "What's your website and email?"
- Write it casually, not like a brochure. The AI mirrors the tone of this file. Keep it under 1 page.
- Replace ALL placeholder text like "[Your Company Name]". The AI will literally say brackets out loud.

**src/instructions.md** — HOW the AI talks.
- The default casual SDR style works for most people. Ask if they want it more professional or more casual.
- The calendar link comes from the CALENDAR_LINK secret, so no links need editing here.

### Step 4: Log in to Cloudflare

Run `npx wrangler login`. It opens a browser. Tell the user: "A Cloudflare page just opened. Sign up or log in (it's free, no card needed), then click Allow."

Confirm with `npx wrangler whoami`.

If the browser shows **"No CSRF value available in the session cookie"**, run `npx wrangler login --browser=false` instead, and tell the user: "Open a Chrome Incognito window (Cmd+Shift+N), paste this link, log in, and click Allow." Incognito avoids the extensions and stale cookies that cause it.

### Step 5: Deploy

Run `npm run deploy`.
- On a brand new account, wrangler registers a workers.dev subdomain automatically. If it asks instead, pick something based on their company name.
- The output ends with the URL, like `https://ai-setter-agent.<subdomain>.workers.dev`. Save it.
- On a first deploy the URL can take a minute or two to work (SSL handshake errors until the certificate is issued). Retry `/health` every 15s until it answers.

Then upload the keys: `npm run secrets` (this runs `wrangler secret bulk .env`).

### Step 6: Connect the webhook in Scrapely

Tell the user exactly this, with their real URL filled in:

1. Go to Scrapely dashboard → **Settings** → **Global Webhook** → **Add Webhook**
2. Paste: `https://ai-setter-agent.<subdomain>.workers.dev`
3. Scrapely generates an `X-Webhook-Key`. **Copy it and paste it here.**
4. Turn on **"Enable Webhook Notifications"** and **"Send Webhook for All Replies"**, then **Save Settings**

When they paste the key: put it in `.env` as `WEBHOOK_SECRETS`, then run `npm run secrets` again.

### Step 7: Verify

Run `curl https://<their-url>/health`. Every field should be `"set"` or `true` and `status` should be `"ok"`. If anything shows `"MISSING"` or `false`, fix it (see below) and check again.

Optional dry run on a real conversation (sends nothing):
`curl -H "X-Webhook-Key: <their key>" "https://<their-url>/test?conversation_id=<id>"`

Tell the user they're live: when leads reply to their Scrapely DMs, the agent answers within a couple of minutes.

## Making Changes Later

- Edited `offer.md`, `instructions.md`, or code → `npm run deploy`
- Changed a key in `.env` → `npm run secrets`
- See live logs → `npm run logs` (or Cloudflare dashboard → Workers → ai-setter-agent → Logs)

## Common Issues and Fixes

- **Always check /health first** — it shows which keys are set and whether offer.md still has placeholders.
- **AI replies sound generic or wrong** → Fill in `src/offer.md` with real business info, then `npm run deploy`.
- **No replies being sent** → Check: (1) Scrapely key is right, (2) webhook URL in Scrapely is the workers.dev URL, (3) WEBHOOK_SECRETS matches the X-Webhook-Key in Scrapely, (4) both webhook toggles are on in Scrapely.
- **403 Forbidden** → WEBHOOK_SECRETS doesn't match Scrapely's X-Webhook-Key. Copy the exact value, `npm run secrets`.
- **503 Not configured** → OPENROUTER_API_KEY or SCRAPELY_API_KEY is missing. `npm run secrets`.
- **"AI setter disabled" in logs** → That conversation has `ai_setter_enabled: false` in Scrapely CRM.
- **LLM 401** → OpenRouter key is wrong. **LLM 402** → OpenRouter is out of credits.
- **`wrangler deploy` says not logged in** → `npx wrangler login`.

## Technical Notes

- Each conversation has its own Durable Object. A webhook stores the payload and sets an alarm 45-90s out; another message resets it. So bursts and duplicate webhooks get one reply.
- The Durable Object remembers the last lead message it answered, so it never answers the same message twice. It skips threads where we (or a human on the team) spoke last, and ignores a bare emoji reaction mid-conversation.
- Right before sending, it reloads the thread and discards the draft if anything changed.
- An hourly cron wakes the FollowupScanner, which finds `interested_reply` leads due for a nudge (day 2, day 7; see `FOLLOWUP_CHAIN` in `src/agent.js`) and hands each to its conversation's Durable Object. Follow-ups are spread over 10 minutes. The follow-up count lives in the Scrapely CRM notes.
- Models: `anthropic/claude-sonnet-4.6` first, falling back to `anthropic/claude-haiku-4.5`. Change them in `src/openrouter.js`.
- All secrets are Cloudflare secrets. Nothing is hardcoded.

## Commands

```
npm install      — Install dependencies
npm run dev      — Run locally (reads .env)
npm run deploy   — Deploy to Cloudflare
npm run secrets  — Upload .env to Cloudflare as secrets
npm run logs     — Stream live logs
```
