/**
 * AI Setter logic: Scrapely API helpers, reply + follow-up generation.
 * Everything here is stateless. Per-conversation state (debounce timers,
 * "already answered" markers) lives in the Durable Objects in index.js.
 */

import { callClaude } from "./openrouter.js";
import INSTRUCTIONS from "./instructions.md";
import OFFER from "./offer.md";

// Follow-up chain config
export const FOLLOWUP_CHAIN = [
  {
    delayDays: 2,
    prompt: `The lead received our pitch but hasn't responded. Send a short, casual nudge referencing what we sent them. Don't re-explain everything — just poke them naturally. One or two sentences max.`,
  },
  {
    delayDays: 7,
    prompt: `The lead still hasn't responded after the first follow-up. Send a final, slightly more direct follow-up. Keep it human and short. Mention the calendar link naturally at the end. Don't be pushy, just give them one more reason to engage.`,
  },
];

// Leads often send 2-3 messages in a row, and Scrapely can fire the same webhook
// twice. Wait for the burst to settle, then reply once to all of it.
export const DEBOUNCE_MIN_MS = 45 * 1000;
export const DEBOUNCE_MAX_MS = 90 * 1000;

// Due follow-ups are spread over this window so they don't all go out at once
export const FOLLOWUP_SPREAD_MS = 10 * 60 * 1000;

// Cloudflare's free plan allows 50 outbound requests per invocation. The hourly
// scan uses one per due conversation, so it hands off at most this many per run
// and picks up the rest next hour.
export const MAX_FOLLOWUPS_PER_RUN = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min));

// ---------------------------------------------------------------------------
// Config checks — catch setup mistakes before they cause silent failures
// ---------------------------------------------------------------------------
// Values from .dev.vars.example; left unchanged they count as not set
const PLACEHOLDERS = new Set(["sk-or-...", "your-scrapely-api-key", "https://calendly.com/your-link", "your-webhook-secret-here"]);

export function getConfig(rawEnv) {
  const env = Object.fromEntries(
    ["OPENROUTER_API_KEY", "SCRAPELY_API_KEY", "CALENDAR_LINK", "WEBHOOK_SECRETS"].map((k) => [k, PLACEHOLDERS.has(rawEnv[k]) ? "" : rawEnv[k]])
  );
  const webhookSecrets = new Set(
    (env.WEBHOOK_SECRETS || "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const offerCustomized = !OFFER.includes("[Your Company Name]") && !OFFER.includes("REPLACE EVERYTHING BELOW");
  const instructionsCustomized =
    !INSTRUCTIONS.includes("[YOUR PROPOSAL/CASE STUDY LINK]") && !INSTRUCTIONS.includes("[YOUR CALENDAR LINK]");

  const warnings = [];
  if (!env.OPENROUTER_API_KEY) {
    warnings.push("OPENROUTER_API_KEY is missing — AI replies will fail. Get one at https://openrouter.ai/settings/keys");
  }
  if (!env.SCRAPELY_API_KEY) {
    warnings.push("SCRAPELY_API_KEY is missing — cannot fetch conversations or send DMs. Find yours in Scrapely Dashboard > Settings > API");
  }
  if (!env.CALENDAR_LINK) {
    warnings.push("CALENDAR_LINK is not set — the AI won't have a booking link to share with leads");
  }
  if (webhookSecrets.size === 0) {
    warnings.push("WEBHOOK_SECRETS is not set — all webhook requests are rejected until you set it to the X-Webhook-Key value from Scrapely Settings");
  }
  if (!offerCustomized) {
    warnings.push("src/offer.md still has placeholder text — the AI won't know what to sell. Edit it with your business info, then redeploy");
  }
  if (!instructionsCustomized) {
    warnings.push("src/instructions.md still has placeholder links — replace [YOUR CALENDAR LINK] and [YOUR PROPOSAL/CASE STUDY LINK] with your actual URLs, then redeploy");
  }

  return {
    webhookSecrets,
    ready: Boolean(env.OPENROUTER_API_KEY && env.SCRAPELY_API_KEY && webhookSecrets.size > 0),
    warnings,
    status: {
      openrouter_key: env.OPENROUTER_API_KEY ? "set" : "MISSING",
      scrapely_key: env.SCRAPELY_API_KEY ? "set" : "MISSING",
      calendar_link: env.CALENDAR_LINK ? "set" : "MISSING",
      webhook_auth: webhookSecrets.size > 0 ? "set" : "MISSING",
      offer_customized: offerCustomized,
      instructions_customized: instructionsCustomized,
    },
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
export function parseCRMNotes(conversation) {
  try {
    const notes = conversation?.crm?.notes;
    if (!notes) return null;
    return JSON.parse(notes);
  } catch {
    return null;
  }
}

// A bare emoji reaction shows up as a lead message like "❤️ reacted"
const isReaction = (msg) => /^\S{1,8} reacted$/.test((msg?.text || "").trim());

// Messages carry no id; lead messages have `timestamp`, ours have `time`
export function messageKey(msg) {
  return msg ? `${msg.timestamp || msg.time || ""}|${msg.text || ""}` : null;
}

function sanitizeReply(text) {
  if (!text) return text;
  return text
    .replace(/[–—]/g, ", ")   // en-dash / em-dash -> comma
    .replace(/ - /g, ", ")              // spaced dash -> comma
    .replace(/^- /gm, "")              // leading list dashes
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{2702}-\u{27B0}\u{2300}-\u{23FF}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function createAgent(env) {
  const SCRAPELY_API_BASE = env.SCRAPELY_API_BASE || "https://app.scrapely.co/api/v1";
  const SCRAPELY_API_KEY = env.SCRAPELY_API_KEY;
  const CALENDAR_LINK = env.CALENDAR_LINK || "";

  // ---------------------------------------------------------------------------
  // Scrapely API helpers
  // ---------------------------------------------------------------------------
  async function scrapely(method, pathname, { params, body, timeout = 15000 } = {}) {
    const url = new URL(`${SCRAPELY_API_BASE}${pathname}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const headers = { "X-API-Key": SCRAPELY_API_KEY };
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, ok: response.ok, data };
  }

  async function fetchAccounts() {
    try {
      const response = await scrapely("GET", "/accounts");
      if (!response.ok) {
        console.error(`[Scrapely] Fetch accounts error: ${response.status}`);
        return [];
      }
      return response.data?.accounts || [];
    } catch (err) {
      console.error(`[Scrapely] Fetch accounts exception: ${err.message}`);
      return [];
    }
  }

  async function sendDM(conversationId, accountId, message) {
    try {
      console.log(`[Scrapely] Sending DM to conversation ${conversationId}...`);
      const response = await scrapely("POST", "/dm/send", {
        body: { conversation_id: conversationId, message, account_id: accountId },
        timeout: 30000,
      });
      if (!response.ok) {
        console.error(`[Scrapely] DM send error: ${response.status} - ${JSON.stringify(response.data)}`);
        return false;
      }
      console.log(`[Scrapely] DM sent successfully`);
      return true;
    } catch (err) {
      console.error(`[Scrapely] DM exception: ${err.message}`);
      return false;
    }
  }

  async function fetchConversation(conversationId) {
    try {
      const response = await scrapely("GET", "/conversations", { params: { conversation_id: conversationId } });
      if (!response.ok) {
        console.error(`[Scrapely] Fetch conversation error: ${response.status}`);
        return null;
      }
      return response.data?.conversation;
    } catch (err) {
      console.error(`[Scrapely] Fetch conversation exception: ${err.message}`);
      return null;
    }
  }

  async function fetchCRMConversations(tag) {
    const allConversations = [];
    let cursor = null;

    try {
      while (true) {
        const params = { tag, include_messages: true, limit: 100 };
        if (cursor) params.cursor = cursor;

        const response = await scrapely("GET", "/crm/conversations", { params, timeout: 30000 });
        if (!response.ok) break;

        const tagData = response.data?.columns?.[tag];
        const convos = tagData?.conversations || [];
        allConversations.push(...convos);

        const nextCursor = response.data?.next_cursor;
        if (!nextCursor || convos.length < 100) break;
        cursor = nextCursor;
      }
      return { conversations: allConversations, count: allConversations.length };
    } catch (err) {
      console.error(`[CRM] Fetch exception: ${err.message}`);
      return { conversations: allConversations, count: allConversations.length };
    }
  }

  async function updateCRMNotes(conversationId, accountHandle, data) {
    try {
      const response = await scrapely("PATCH", "/crm/update", {
        body: { conversation_id: conversationId, account_handle: accountHandle, notes: JSON.stringify(data) },
      });
      return response.ok;
    } catch (err) {
      console.error(`[CRM] Update exception: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // AI Setter: generate reply for back-and-forth conversations
  // ---------------------------------------------------------------------------
  async function generateSetterReply(conversationMessages, leadContext, originalOutboundDm) {
    const { senderScreenName, senderName, senderDescription, companyName, website } = leadContext;

    const leadMessages = conversationMessages.filter((m) => !m.isSent).map((m) => m.text);
    const leadTonality = leadMessages.slice(-3).join(" | ");

    let systemPrompt = `You are a Twitter SDR responding to DMs from leads.
Match the lead's style (slang, short, or formal).
Stay natural, casual, never robotic.
Never reveal you're AI.
Use contractions instead of full words (e.g. "don't" instead of "do not").
Include question marks (?) for questions.
NEVER use dashes (-), en-dashes, or em-dashes in your response. Use commas, periods, or separate sentences instead.
NEVER use emojis. Zero. None.

Lead: @${senderScreenName} — ${senderName}
Lead Bio: ${senderDescription || "N/A"}
Lead Style Sample: ${leadTonality}

Account Instructions: ${INSTRUCTIONS}
Account Offer: ${OFFER}`;

    if (companyName) systemPrompt += `\n\nLead's Company: ${companyName}`;
    if (website) systemPrompt += `\nLead's Website: ${website}`;
    if (originalOutboundDm) systemPrompt += `\n\nYour opening DM to this lead was: "${originalOutboundDm}"`;
    systemPrompt += `\n\nCalendar link (use when pushing for a call): ${CALENDAR_LINK}`;
    systemPrompt += `\n\nRespond with your next message only. No quotes, no explanation, no prefixes. Just the message text.`;

    // Map conversation history to Claude messages
    const claudeMessages = [];
    for (const msg of conversationMessages) {
      const role = msg.isSent ? "assistant" : "user";
      if (claudeMessages.length > 0 && claudeMessages[claudeMessages.length - 1].role === role) {
        claudeMessages[claudeMessages.length - 1].content += "\n" + msg.text;
      } else {
        claudeMessages.push({ role, content: msg.text });
      }
    }

    // Claude requires messages to start with user role
    if (claudeMessages.length > 0 && claudeMessages[0].role === "assistant") {
      claudeMessages.shift();
    }

    // Claude requires messages to end with user role
    if (claudeMessages.length === 0 || claudeMessages[claudeMessages.length - 1].role !== "user") {
      console.log(`[Setter] No new user message to respond to, skipping`);
      return null;
    }

    console.log(`[Setter] Generating reply with ${claudeMessages.length} messages in history...`);

    let reply = await callClaude(env.OPENROUTER_API_KEY, claudeMessages, { system: systemPrompt, maxTokens: 300 });
    if (reply) {
      reply = sanitizeReply(reply);
      console.log(`[Setter] Generated reply: "${reply}"`);
    }
    return reply;
  }

  // ---------------------------------------------------------------------------
  // Follow-up message generation (for stale leads)
  // ---------------------------------------------------------------------------
  async function generateFollowUpMessage(leadContext, followupPrompt, conversationMessages) {
    const { senderScreenName, senderName, senderDescription, companyName, website } = leadContext;

    const recentMessages = (conversationMessages || [])
      .slice(-6)
      .map((m) => `${m.isSent || m.is_sent ? "Us" : "Lead"}: ${m.text}`)
      .join("\n");

    const systemPrompt = `You are a Twitter SDR sending a follow-up DM. The lead went silent.
Match their tone from prior messages. Stay casual, human, short. No corporate speak. Max 2-3 sentences.
NEVER use dashes (-), en-dashes, or em-dashes. Use commas, periods, or separate sentences instead.
NEVER use emojis. Zero. None.

Account Instructions: ${INSTRUCTIONS}
Account Offer: ${OFFER}

Lead: @${senderScreenName} — ${senderName}
Lead Bio: ${senderDescription || "N/A"}
${companyName ? `Company: ${companyName}` : ""}
${website ? `Website: ${website}` : ""}
Calendar link: ${CALENDAR_LINK}

Recent conversation:
${recentMessages}

Respond with your follow-up message only. No quotes, no explanation, no prefixes. Just the message text.`;

    const resolvedPrompt = followupPrompt.replace("{calendar_link}", CALENDAR_LINK);

    let reply = await callClaude(
      env.OPENROUTER_API_KEY,
      [{ role: "user", content: resolvedPrompt }],
      { system: systemPrompt, maxTokens: 200 }
    );

    if (reply) {
      reply = sanitizeReply(reply);
      console.log(`[FollowUp] Generated: "${reply}"`);
    }
    return reply;
  }

  // ---------------------------------------------------------------------------
  // Reply to a conversation. `lastRepliedKey` is the key of the lead message we
  // last answered; returns the new key if a reply went out, otherwise null.
  // ---------------------------------------------------------------------------
  async function processConversation(payload, lastRepliedKey) {
    const senderScreenName = payload.sender_screen_name;
    const conversationId = payload.conversation_id;
    const accountId = payload.account_id;
    const accountHandle = payload.account_twitter_handle;

    console.log(`[Process] Reply from @${senderScreenName}, fetching conversation...`);

    const conversation = await fetchConversation(conversationId);
    const messages = conversation?.messages;
    if (!messages?.length) {
      console.error(`[Process] Failed to fetch conversation ${conversationId}`);
      return null;
    }

    // Check if AI setter is disabled for this conversation
    if (conversation.crm?.ai_setter_enabled === false) {
      console.log(`[Process] AI setter disabled for @${senderScreenName}, skipping`);
      return null;
    }

    // Someone (us or a human on the team) already answered the latest lead message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.isSent) {
      console.log(`[Process] Last message to @${senderScreenName} is already ours, skipping`);
      return null;
    }
    if (lastRepliedKey === messageKey(lastMessage)) {
      console.log(`[Process] Already answered this message from @${senderScreenName}, skipping`);
      return null;
    }

    // A bare reaction after we've already been talking doesn't need an answer
    let lastSentIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isSent) { lastSentIndex = i; break; }
    }
    const newLeadMessages = messages.slice(lastSentIndex + 1);
    const isFirstResponse = messages.filter((m) => !m.isSent).length === newLeadMessages.length;
    if (!isFirstResponse && newLeadMessages.every(isReaction)) {
      console.log(`[Process] Only a reaction from @${senderScreenName}, not replying`);
      return null;
    }

    // Parse CRM notes for stored context
    const crmData = parseCRMNotes(conversation);
    const companyName = crmData?.company_name || null;
    const website = crmData?.website || null;

    // Find original outbound DM
    const originalOutboundDm = messages.find((m) => m.isSent)?.text || null;

    // Build lead context
    const lead = conversation.lead || {};
    const leadContext = {
      senderScreenName: lead.screen_name || senderScreenName,
      senderName: lead.name || payload.lead_name || senderScreenName,
      senderDescription: lead.bio || payload.lead_description || null,
      companyName,
      website,
    };

    // Generate AI reply
    const reply = await generateSetterReply(messages, leadContext, originalOutboundDm);
    if (!reply) {
      console.log(`[Process] No reply generated for @${senderScreenName}`);
      return null;
    }

    // Human-like delay (5-15s)
    const delay = randomBetween(5000, 15000);
    console.log(`[Process] Waiting ${Math.round(delay / 1000)}s before replying...`);
    await sleep(delay);

    // The lead may have kept typing (or a human may have replied) while we were generating
    const latest = await fetchConversation(conversationId);
    const latestLast = latest?.messages?.[latest.messages.length - 1];
    if (latestLast && messageKey(latestLast) !== messageKey(lastMessage)) {
      console.log(`[Process] Conversation with @${senderScreenName} changed while generating, discarding draft`);
      return null;
    }

    // Send the reply
    await sendDM(conversationId, accountId, reply);

    // Reset follow-up chain
    if (accountHandle && crmData) {
      crmData.followup_count = 0;
      crmData.last_followup_at = null;
      await updateCRMNotes(conversationId, accountHandle, crmData);
    }

    console.log(`[Process] Reply sent to @${senderScreenName}: "${reply}"`);
    return messageKey(lastMessage);
  }

  // ---------------------------------------------------------------------------
  // Follow-ups, step 1: scan the CRM for stale leads. Returns the due jobs;
  // each one is then sent from its own conversation's Durable Object.
  // ---------------------------------------------------------------------------
  async function findDueFollowups() {
    console.log(`[FollowUp] Checking for stale leads needing follow-up...`);

    const tagData = await fetchCRMConversations("interested_reply");
    if (!tagData?.conversations || tagData.conversations.length === 0) {
      console.log(`[FollowUp] No interested_reply conversations to check`);
      return [];
    }

    // Build handle → account_id lookup (CRM endpoint doesn't return account_id)
    const accounts = await fetchAccounts();
    const handleToAccountId = {};
    for (const acc of accounts) {
      if (acc.handle && acc.id) handleToAccountId[acc.handle.toLowerCase()] = acc.id;
    }

    const now = Date.now();
    const due = [];

    for (const conv of tagData.conversations) {
      const lastMsg = conv.last_message;
      if (!lastMsg || !lastMsg.is_sent) continue;

      if (conv.crm?.ai_setter_enabled === false) continue;

      // Skip conversations from inactive/banned accounts
      const accountHandle = conv.account_handle || conv.lead?.account_handle;
      const accountId = conv.account_id || (accountHandle && handleToAccountId[accountHandle.toLowerCase()]);
      if (!accountId) {
        console.log(`[FollowUp] Skipping conversation ${conv.conversation_id} — account "${accountHandle}" is not active`);
        continue;
      }

      const rawTime = lastMsg.time || 0;
      const lastMsgTime = typeof rawTime === "string" ? new Date(rawTime).getTime() : rawTime;
      const daysSinceLastMsg = (now - lastMsgTime) / (1000 * 60 * 60 * 24);

      const notes = parseCRMNotes(conv) || {};
      const followupCount = notes.followup_count || 0;

      if (followupCount >= FOLLOWUP_CHAIN.length) continue;
      if (daysSinceLastMsg < FOLLOWUP_CHAIN[followupCount].delayDays) continue;

      const lead = conv.lead || {};
      due.push({
        conversationId: conv.conversation_id,
        accountId,
        accountHandle,
        followupCount,
        notes,
        leadContext: {
          senderScreenName: lead.screen_name || conv.receiver_screen_name || "unknown",
          senderName: lead.name || "unknown",
          senderDescription: lead.bio || null,
          companyName: notes.company_name || null,
          website: notes.website || null,
        },
      });
    }

    console.log(`[FollowUp] ${due.length} lead(s) due for a follow-up`);
    return due;
  }

  // ---------------------------------------------------------------------------
  // Follow-ups, step 2: send one follow-up. Returns true if it went out.
  // ---------------------------------------------------------------------------
  async function sendFollowup(job) {
    const { conversationId, accountId, accountHandle, leadContext } = job;

    const fullConversation = await fetchConversation(conversationId);
    if (!fullConversation?.messages) return false;
    // The CRM listing can lag behind, make sure the lead hasn't answered since
    if (!fullConversation.messages[fullConversation.messages.length - 1]?.isSent) return false;
    if (fullConversation.crm?.ai_setter_enabled === false) return false;

    // Prefer fresh CRM notes so a follow-up never goes out twice
    const notes = parseCRMNotes(fullConversation) || job.notes || {};
    const followupCount = notes.followup_count || 0;
    if (followupCount !== job.followupCount) return false;

    const followupMsg = await generateFollowUpMessage(
      leadContext,
      FOLLOWUP_CHAIN[followupCount].prompt,
      fullConversation.messages
    );
    if (!followupMsg) return false;

    // Human-like delay
    await sleep(randomBetween(3000, 10000));

    const sent = await sendDM(conversationId, accountId, followupMsg);
    if (!sent) return false;

    // Update follow-up count in CRM
    notes.followup_count = followupCount + 1;
    notes.last_followup_at = new Date().toISOString();
    if (accountHandle) {
      await updateCRMNotes(conversationId, accountHandle, notes);
    }

    console.log(`[FollowUp] Sent follow-up #${followupCount + 1} to @${leadContext.senderScreenName}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Dry run for /test — generates a reply + follow-up previews, sends nothing
  // ---------------------------------------------------------------------------
  async function dryRun(conversationId) {
    const conversation = await fetchConversation(conversationId);
    if (!conversation?.messages?.length) return null;

    const crmData = parseCRMNotes(conversation);
    const lead = conversation.lead || {};
    const originalOutbound = conversation.messages.find((m) => m.isSent);

    const leadContext = {
      senderScreenName: lead.screen_name || "unknown",
      senderName: lead.name || "unknown",
      senderDescription: lead.bio || null,
      companyName: crmData?.company_name || null,
      website: crmData?.website || null,
    };

    const reply = await generateSetterReply(conversation.messages, leadContext, originalOutbound?.text || null);

    const followupPreviews = [];
    for (const fu of FOLLOWUP_CHAIN) {
      const fuMsg = await generateFollowUpMessage(leadContext, fu.prompt, conversation.messages);
      followupPreviews.push({ delayDays: fu.delayDays, message: fuMsg });
    }

    return {
      conversation_id: conversationId,
      lead: { handle: leadContext.senderScreenName, name: leadContext.senderName, bio: leadContext.senderDescription },
      crm_context: crmData,
      message_count: conversation.messages.length,
      setter_reply: reply || "(no reply generated)",
      followup_chain_previews: followupPreviews,
      note: "DRY RUN — nothing was sent",
    };
  }

  return { processConversation, findDueFollowups, sendFollowup, dryRun };
}
