# AI Setter Agent for Scrapely

An AI-powered assistant that automatically replies to your Twitter DM leads through Scrapely. It reads incoming messages, generates human-like responses with Claude, and books calls for you — on autopilot.

Runs free on Cloudflare Workers. No server to manage, one-click deploy.

## What it does

- **Auto-replies to leads** — When someone responds to your outbound DMs, the AI generates a natural, casual reply
- **Follows up automatically** — If a lead goes quiet, it sends follow-up nudges on day 2 and day 7
- **Books calls** — Drops your calendar link at the right moment to push leads toward a call
- **Matches their tone** — Short replies for short messages, casual when they're casual

## Setup (5 minutes, no coding)

Before you start, have these ready:
- An **OpenRouter** API key with credits: [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) (add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits))
- Your **Scrapely** API key: Scrapely dashboard → Settings → API Keys → Create Key
- Your **calendar link** (Calendly, Cal.com, etc.)

### 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/deepblue6/AI-agent-scrapely-v2)

Click the button. Cloudflare will ask you to sign in (free, no card) and connect GitHub, then copy this project into your own GitHub and deploy it. When it asks for secrets, paste your OpenRouter key, Scrapely key and calendar link. **Leave `WEBHOOK_SECRETS` as the placeholder**, you'll get the real value in step 2.

When it's done, copy your Worker URL. It looks like `https://ai-setter-agent.<your-name>.workers.dev`.

### 2. Connect Scrapely

1. Scrapely dashboard → **Settings** → **Global Webhook** → **Add Webhook**, paste your Worker URL
2. Copy the **X-Webhook-Key** Scrapely generates
3. In Cloudflare: **Workers & Pages** → **ai-setter-agent** → **Settings** → **Variables and Secrets** → edit `WEBHOOK_SECRETS`, paste the key, **Deploy**
4. Back in Scrapely, turn on **"Enable Webhook Notifications"** and **"Send Webhook for All Replies"**, then **Save Settings**

### 3. Tell the AI what you sell

In **your** copy of the repo on GitHub (Cloudflare created it in step 1), open **`src/offer.md`** and replace everything with your business: what you sell, results, pricing. See `src/offer.example.md` for a filled-in example. **This is the most important file** — the agent stays in "needs setup" until you do it.

Optional: `src/instructions.md` controls how the AI talks (tone, style). The default casual style works for most people.

Click the pencil icon on a file, edit, then **Commit changes**. Cloudflare redeploys automatically within a minute.

### 4. Check it

Open `https://<your-worker-url>/health`. Everything should say `"set"` or `true` and `status` should be `"ok"`. If not, it tells you exactly what's missing.

That's it. When leads reply to your Scrapely DMs, the agent answers within a couple of minutes.

### Prefer an AI agent to do it?

Clone the repo, open it in Claude Code (or any coding agent) and say **"set this up for me"**. It follows `CLAUDE.md`: asks for your keys and your offer, deploys with the Cloudflare CLI, and tells you what to paste into Scrapely.

### Or by hand (command line)

```bash
npm install
cp .dev.vars.example .env     # fill in OPENROUTER_API_KEY, SCRAPELY_API_KEY, CALENDAR_LINK
# replace src/offer.md with your business (see src/offer.example.md)
npx wrangler login            # opens the browser, free account
npm run deploy                # prints your URL: https://ai-setter-agent.<you>.workers.dev
npm run secrets               # uploads .env to Cloudflare
```
Then connect Scrapely as in step 2, put the X-Webhook-Key in `.env` as `WEBHOOK_SECRETS`, and run `npm run secrets` again.

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter key (account needs credits) |
| `SCRAPELY_API_KEY` | Yes | Your Scrapely API key |
| `CALENDAR_LINK` | Yes | Your booking link (Calendly, Cal.com, etc.) |
| `WEBHOOK_SECRETS` | Yes | The `X-Webhook-Key` from Scrapely Settings > Global Webhook |

**Follow-up timing** — day 2 and day 7 by default. Edit `FOLLOWUP_CHAIN` in `src/agent.js`.

**Models** — Claude Sonnet 4.6, falling back to Haiku 4.5. Edit `src/openrouter.js`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Config status check — shows which keys are set and any issues |
| `GET` | `/test?conversation_id=XXX` | Dry-run — generates a reply without sending it (needs the `X-Webhook-Key` header) |
| `POST` | `/` | Main webhook receiver |

## Safety Features

- Skips negative sentiment replies (won't engage angry leads)
- Waits 45-90s for the lead to finish typing, then sends one reply to the whole burst (duplicate webhooks are ignored)
- Never replies to the same message twice, and stays quiet if someone on your team already answered
- Re-checks the thread right before sending and throws the draft away if the lead said something new
- Respects `ai_setter_enabled: false` flag in Scrapely CRM
- Strips emojis and formatting from AI output

## Writing Your Offer (src/offer.md)

This is the most important file — it's what the AI knows about your business. If this is generic, the AI will sound generic. See `src/offer.example.md` for a filled-in example.

- Write like you're explaining your business to a friend, not writing a brochure
- Include real numbers ("12 calls in 2 weeks" beats "great results")
- Add 2-3 client results or testimonials — the AI uses these as proof points
- Mention pricing ranges so the AI can answer price questions without being evasive
- Keep it under 1 page
- Don't leave placeholder text — the AI will literally say "[Your Company Name]"

After editing, run `npm run deploy`.

## Troubleshooting

**First thing to check** — `https://<your-url>/health`.

**Logs** — `npm run logs` streams them live, or Cloudflare dashboard → Workers & Pages → ai-setter-agent → Logs. Lines are prefixed `[Webhook]`, `[Setter]`, `[FollowUp]`, `[LLM]`.

**No replies being sent** — Check that your Scrapely key is right, the webhook URL in Scrapely is your workers.dev URL, `WEBHOOK_SECRETS` matches the `X-Webhook-Key`, and both webhook toggles are on.

**403 Forbidden** — `WEBHOOK_SECRETS` doesn't match Scrapely's `X-Webhook-Key`. Fix `.env`, run `npm run secrets`.

**AI errors (401 / 402)** — 401 means the OpenRouter key is wrong, 402 means it's out of credits.

**AI replies sound off** — Edit `src/instructions.md` and `src/offer.md`, then `npm run deploy`.
