/**
 * AI Setter Agent — Cloudflare Worker
 *
 * Listens for Scrapely webhook events and generates AI replies using Claude.
 * An AI setter that books calls.
 *
 * Endpoints:
 *   POST /           — Main webhook receiver (new_reply + reply_back_and_forth)
 *   GET  /health     — Health check
 *   GET  /test?conversation_id=XXX — Dry-run (generates reply, doesn't send)
 *
 * Every conversation gets its own Durable Object (Conversation), which holds the
 * debounce timer (an alarm) and remembers which message it last answered. An
 * hourly cron wakes the FollowupScanner, which finds stale leads and hands each
 * one to its Conversation to send the follow-up.
 */

import { DurableObject } from "cloudflare:workers";
import {
  createAgent,
  getConfig,
  DEBOUNCE_MIN_MS,
  DEBOUNCE_MAX_MS,
  FOLLOWUP_CHAIN,
  FOLLOWUP_SPREAD_MS,
  MAX_FOLLOWUPS_PER_RUN,
} from "./agent.js";

const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min));
const stub = (namespace, name) => namespace.get(namespace.idFromName(name));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// One Durable Object per conversation (debounced, one run at a time)
// ---------------------------------------------------------------------------
export class Conversation extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.running = false;
    this.rerun = false;
  }

  // A webhook arrived: merge it in and (re)start the debounce timer
  async queueReply(payload) {
    const stored = (await this.ctx.storage.get("payload")) || {};
    // new_reply carries sentiment + lead fields, later events may not, so merge
    const merged = { ...stored, ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v != null)) };
    await this.ctx.storage.put("payload", merged);

    if (this.running) {
      this.rerun = true;
      return;
    }
    const delay = randomBetween(DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);
    console.log(`[Process] @${payload.sender_screen_name} queued, replying in ~${Math.round(delay / 1000)}s unless they keep typing`);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  // The scanner found this lead due for a follow-up
  async queueFollowup(job) {
    if (await this.ctx.storage.get("payload")) return; // a reply is already on its way
    await this.ctx.storage.put("followup", job);
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + randomBetween(0, FOLLOWUP_SPREAD_MS));
    }
  }

  async dryRun(conversationId) {
    return createAgent(this.env).dryRun(conversationId);
  }

  async alarm() {
    const agent = createAgent(this.env);
    const payload = await this.ctx.storage.get("payload");

    if (payload) {
      this.running = true;
      try {
        const lastRepliedKey = await this.ctx.storage.get("lastRepliedTo");
        const repliedKey = await agent.processConversation(payload, lastRepliedKey);
        if (repliedKey) await this.ctx.storage.put("lastRepliedTo", repliedKey);
      } catch (err) {
        // Never throw from an alarm: Cloudflare would retry it and could double-send
        console.error(`[Process] Error for ${payload.conversation_id}: ${err.message}`);
      }
      this.running = false;
      await this.ctx.storage.delete("followup");
      if (this.rerun) {
        this.rerun = false;
        await this.ctx.storage.setAlarm(Date.now() + randomBetween(DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS));
      } else {
        await this.ctx.storage.delete("payload");
      }
      return;
    }

    const followup = await this.ctx.storage.get("followup");
    if (followup) {
      await this.ctx.storage.delete("followup");
      try {
        await agent.sendFollowup(followup);
      } catch (err) {
        console.error(`[FollowUp] Error processing conversation ${followup.conversationId}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Follow-up scanner — a single Durable Object, woken by the hourly cron
// ---------------------------------------------------------------------------
export class FollowupScanner extends DurableObject {
  async start() {
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async alarm() {
    try {
      const due = await createAgent(this.env).findDueFollowups();
      const batch = due.slice(0, MAX_FOLLOWUPS_PER_RUN);
      for (const job of batch) {
        await stub(this.env.CONVERSATIONS, job.conversationId).queueFollowup(job);
      }
      if (due.length > batch.length) {
        console.log(`[FollowUp] Queued ${batch.length}, the other ${due.length - batch.length} go out next hour`);
      } else {
        console.log(`[FollowUp] Queued ${batch.length} follow-up(s)`);
      }
    } catch (err) {
      console.error(`[FollowUp] Loop error: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getConfig(env);

    // Health check (no auth required) — shows config status for debugging
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: config.warnings.length === 0 ? "ok" : "needs_setup",
        service: "ai-setter-agent",
        config: config.status,
        issues: config.warnings.length > 0 ? config.warnings : undefined,
      });
    }

    // Root GET — friendly landing page for people visiting in a browser
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "ai-setter-agent",
        status: config.warnings.length === 0 ? "running" : "needs_setup",
        hint: "This is a webhook server. Scrapely sends POST requests here. Visit /health to check your config.",
        endpoints: {
          health: "/health",
          test: "/test?conversation_id=YOUR_CONVERSATION_ID (needs the X-Webhook-Key header)",
          webhook: "POST /",
        },
        followup_chain: FOLLOWUP_CHAIN.map((f, i) => `#${i + 1} after ${f.delayDays}d`),
      });
    }

    // Webhook auth — every other request must have a valid X-Webhook-Key
    if (!config.webhookSecrets.has(request.headers.get("x-webhook-key"))) {
      return json({ error: "Forbidden — invalid or missing X-Webhook-Key header" }, 403);
    }

    if (!config.ready) {
      return json({ error: "Not configured — visit /health to see what's missing" }, 503);
    }

    // Test endpoint — dry-run
    if (request.method === "GET" && url.pathname === "/test") {
      const conversationId = url.searchParams.get("conversation_id");
      if (!conversationId) return json({ error: "Missing ?conversation_id= param" }, 400);
      try {
        const result = await stub(env.CONVERSATIONS, conversationId).dryRun(conversationId);
        if (!result) return json({ error: "Conversation not found or empty" }, 404);
        return json(result);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // Main webhook endpoint
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      console.error(`[Webhook] JSON parse error: ${err.message}`);
      return json({ received: true });
    }

    console.log(`[Webhook] Event: ${payload.event} from @${payload.sender_screen_name || "unknown"} (back_and_forth: ${payload.is_back_and_forth})`);

    if (payload.event !== "new_reply" && payload.event !== "reply_back_and_forth") {
      console.log(`[Webhook] Skipping event type: ${payload.event}`);
      return json({ received: true });
    }
    if (payload.sentiment === "negative") {
      console.log(`[Process] Negative sentiment from @${payload.sender_screen_name}, skipping`);
      return json({ received: true });
    }
    if (!payload.conversation_id || !payload.account_id) {
      console.error(`[Process] Missing conversation_id or account_id, skipping`);
      return json({ received: true });
    }

    await stub(env.CONVERSATIONS, payload.conversation_id).queueReply(payload);
    return json({ received: true });
  },

  // Hourly cron — kicks off the follow-up scan
  async scheduled(event, env, ctx) {
    if (!getConfig(env).ready) {
      console.log(`[FollowUp] Skipping, not configured yet (visit /health)`);
      return;
    }
    ctx.waitUntil(stub(env.FOLLOWUPS, "scanner").start());
  },
};
