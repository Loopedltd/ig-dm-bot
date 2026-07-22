import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import jwt from "jsonwebtoken";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import { Resend } from "resend";
import { supabase } from "./supabaseClient.js";
import {
  PITCH_DISMISSAL_MESSAGE,
  normaliseTriggerText,
  parseKeywordFromPhrase,
  computeConversationGap,
  isCasualGreeting,
  detectDirectProductRequest,
  detectPersonalQuestion,
  detectUnknownProductMention,
  detectSalesPitch,
  detectGenuineLeadQuestion,
  isStoryReplyTrigger,
  shouldUseStoryAutoDm,
  isCommentReplyTrigger,
  shouldUseCommentAutoDm,
  shouldUseKeywordAutoDm,
} from "./lib/conversationLogic.js";

// ─── Real-time activity stream (SSE) ─────────────────────────────────────────
/** clientId -> Set<Express res> */
const activityStreamClients = new Map();
/** "clientId:igPsid" -> displayName — populated on DM received, used in processDmQueue */
const leadNameCache = new Map();

function emitActivityEvent(clientId, event) {
  const clients = activityStreamClients.get(clientId);
  if (!clients || clients.size === 0) {
    console.log(`[activity] emit ${event.type} for ${clientId} — no SSE clients connected`);
    return;
  }
  console.log(`[activity] emit ${event.type} for ${clientId} — broadcasting to ${clients.size} client(s)`);
  const payload = JSON.stringify({ ...event, ts: new Date().toISOString() });
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
      // Flush immediately so Render/nginx doesn't buffer SSE chunks
      if (typeof res.flush === "function") res.flush();
    } catch {
      clients.delete(res);
    }
  }
}

// Load env only for local/dev (Render injects env vars itself)
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// ---- PATH HELPERS ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/**
 * IMPORTANT:
 * Stripe webhook signature verification needs the raw request body.
 * We keep express.json globally, but capture rawBody for webhook verification.
 */
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// ✅ Serve admin + coach UI
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "admin")));
app.use("/coach", express.static(path.join(__dirname, "coach")));

// Redirects
app.get("/admin", (req, res) => res.redirect("/admin/login.html"));
app.get("/coach", (req, res) => res.redirect("/coach/login.html"));

// robots.txt — allow all crawlers including Meta's link previewer
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nAllow: /\n\nUser-agent: facebookexternalhit\nAllow: /\n"
  );
});

// Privacy + Terms pages
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

app.get("/welcome", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "welcome.html"));
});

app.get("/planner", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "planner.html"), (err) => {
    if (err && !res.headersSent) res.status(500).send("Error loading planner");
  });
});

app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "demo.html"), (err) => {
    if (err && !res.headersSent) res.status(500).send("Error loading demo page");
  });
});

// Clean SaaS routes
app.get("/checkout", (req, res) => {
  if (!isPayHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }

  const token = req.query.token;

  if (!token) {
    return res.sendFile(path.join(__dirname, "public", "invalid-link.html"));
  }

  return res.sendFile(path.join(__dirname, "public", "pay.html"));
});

app.get("/success", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/cancel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cancel.html"));
});

app.get("/login", (req, res) => {
  return res.sendFile(path.join(__dirname, "coach", "login.html"));
});

app.get("/dashboard", (req, res) => {
  return res.sendFile(path.join(__dirname, "coach", "dashboard.html"));
});

app.get("/stats", (req, res) => {
  return res.sendFile(path.join(__dirname, "coach", "stats.html"));
});

app.get("/settings", (req, res) => {
  return res.sendFile(path.join(__dirname, "coach", "settings.html"));
});

app.get("/leads-page", (req, res) => {
  return res.sendFile(path.join(__dirname, "coach", "leads-page.html"));
});

app.get("/set-password", (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "set-password.html"));
});

// ---- ENV SAFETY ----
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
if (!VERIFY_TOKEN) {
  throw new Error("❌ VERIFY_TOKEN is NOT set. Meta webhook verification will fail.");
}

const DASHBOARD_JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;
const DASHBOARD_ADMIN_EMAIL = process.env.DASHBOARD_ADMIN_EMAIL;
const DASHBOARD_ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD;

const COACH_JWT_SECRET = process.env.COACH_JWT_SECRET;

if (process.env.NODE_ENV === "production") {
  if (!COACH_JWT_SECRET) throw new Error("❌ COACH_JWT_SECRET is not set");
  if (!DASHBOARD_JWT_SECRET) throw new Error("❌ DASHBOARD_JWT_SECRET is not set");
  if (!DASHBOARD_ADMIN_EMAIL) throw new Error("❌ DASHBOARD_ADMIN_EMAIL is not set");
  if (!DASHBOARD_ADMIN_PASSWORD) throw new Error("❌ DASHBOARD_ADMIN_PASSWORD is not set");
}

// ---- OPENAI (OPTIONAL) ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---- STRIPE ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;
const META_CONFIG_ID = process.env.META_CONFIG_ID;
// Instagram App (separate from Meta App — created under Instagram > API setup with Instagram login)
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
// Redirect URI for the Facebook Login for Business callback (must be registered in Meta App Dashboard)
const META_FB_REDIRECT_URI = process.env.META_FB_REDIRECT_URI;

const STRIPE_PRICE_SETUP =
  process.env.STRIPE_PRICE_SETUP || "price_1T7bDyCS3UXrJEm9cHGA2lrG";

const STRIPE_PRICE_MONTHLY =
  process.env.STRIPE_PRICE_MONTHLY || "price_1T7bCICS3UXrJEm9s9f7UnEF";

const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || APP_BASE_URL;
const PAY_PUBLIC_URL = process.env.PAY_PUBLIC_URL || APP_BASE_URL;

const stripe =
  STRIPE_SECRET_KEY && typeof STRIPE_SECRET_KEY === "string"
    ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
    : null;

function assertStripeConfigured() {
  if (!stripe) throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("Stripe not configured: missing STRIPE_WEBHOOK_SECRET");
  }
}
const MAX_PROMPTS_PER_DAY = 10;
// ---- SMALL HELPERS ----
const nowIso = () => new Date().toISOString();
const MAX_AI_CALLS_PER_MIN = 30;

global.aiCalls = global.aiCalls || [];

async function withTimeout(promise, ms = 8000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms)
  );
  return Promise.race([promise, timeout]);
}
async function sendWithRetry(fn, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }

  throw lastError;
}
function safeJson(res, status, payload) {
  try {
    return res.status(status).json(payload);
  } catch {
    try {
      return res.status(status).send(JSON.stringify(payload));
    } catch {
      return res.end();
    }
  }
}
// In-memory ring buffer for webhook_async_errors — keyed by clientId
// Each entry: { ts: Date, error: string }
const recentWebhookErrors = new Map(); // clientId -> [{ ts, error }]

function recordWebhookError(clientId, errorMsg) {
  if (!clientId) return;
  const list = recentWebhookErrors.get(clientId) || [];
  list.push({ ts: new Date(), error: String(errorMsg || "unknown") });
  // Keep last 50 per client
  if (list.length > 50) list.splice(0, list.length - 50);
  recentWebhookErrors.set(clientId, list);
}

function log(event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    })
  );
  if (event === "webhook_async_error" && data.clientId) {
    recordWebhookError(data.clientId, data.error);
  }
}

function msSince(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isAllowedStripeStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "trialing" || s === "demo";
}

function getHost(req) {
  return String(req.headers.host || "").toLowerCase().split(":")[0];
}

function isPayHost(req) {
  return getHost(req) === "pay.looped.ltd";
}

function isAppHost(req) {
  return getHost(req) === "app.looped.ltd";
}

// ---------------------------
// IG HELPERS (webhook parsing)
// ---------------------------
function extractIgText(messaging) {
  const directText = String(messaging?.message?.text || "").trim();
  if (directText) return directText;

  const firstAttachment = messaging?.message?.attachments?.[0];
  const attachmentUrl = String(firstAttachment?.payload?.url || "").trim();
  if (attachmentUrl) return attachmentUrl;

  const quickReply = String(messaging?.message?.quick_reply?.payload || "").trim();
  if (quickReply) return quickReply;

  return "";
}

function isIgEcho(messaging) {
  return !!messaging?.message?.is_echo;
}

function getAllIgMessagingEvents(reqBody) {
  const entries = Array.isArray(reqBody?.entry) ? reqBody.entry : [];

  const events = [];
  for (const entry of entries) {
    const messagingItems = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const messaging of messagingItems) {
      events.push({ entry, messaging });
    }
  }

  return events;
}

function extractFollowEvents(reqBody) {
  const entries = Array.isArray(reqBody?.entry) ? reqBody.entry : [];
  const followEvents = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (
        change?.field === "follows" &&
        change?.value?.verb === "follow" &&
        change?.value?.follower_id
      ) {
        followEvents.push({
          igAccountId: entry.id,
          followerId: String(change.value.follower_id),
        });
      }
    }
  }

  return followEvents;
}

function extractPostCommentEvents(reqBody) {
  // Fires when someone comments on a post/reel owned by the page.
  // Meta sends entry.changes[].field === "comments"
  const entries = Array.isArray(reqBody?.entry) ? reqBody.entry : [];
  const commentEvents = [];

  // Log every change field seen so we can confirm comment events arrive
  const allChangeFields = entries.flatMap((e) =>
    Array.isArray(e?.changes) ? e.changes.map((c) => c?.field || "(no field)") : []
  );
  console.log("[comment_webhook] extractPostCommentEvents: change fields seen in this request:", allChangeFields.length ? allChangeFields : "(none)");

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      // ── Instagram comment events (field === "comments") ──────────────────────
      // Arrives when subscribed via /{ig-user-id}/subscribed_apps with "comments"
      if (change?.field === "comments" && change?.value) {
        const v = change.value;
        const commentText = v?.text || v?.message || "";
        if (v?.from?.id && v?.id && commentText) {
          commentEvents.push({
            igAccountId: entry.id,
            commentId: String(v.id),
            commenterId: String(v.from.id),
            commenterUsername: v?.from?.username ? String(v.from.username) : null,
            commentText: String(commentText),
          });
        } else {
          console.log("extractPostCommentEvents: comment dropped — missing field(s)", {
            field: "comments",
            hasFromId: !!v?.from?.id,
            hasId: !!v?.id,
            hasText: !!v?.text,
            hasMessage: !!v?.message,
            raw: JSON.stringify(v).slice(0, 200),
          });
        }
      }

      // ── Facebook Page feed events (field === "feed") ──────────────────────────
      // Arrives when subscribed via /{page-id}/subscribed_apps with "feed".
      // Contains post comments, comment replies, etc. Filter to new comments only.
      if (change?.field === "feed" && change?.value) {
        const v = change.value;
        const isNewComment = v?.item === "comment" && v?.verb === "add";
        if (isNewComment) {
          const commentText = v?.message || v?.text || "";
          const commentId = v?.comment_id || v?.id || null;
          const fromId = v?.from?.id || null;
          if (fromId && commentId && commentText) {
            commentEvents.push({
              igAccountId: entry.id,
              commentId: String(commentId),
              commenterId: String(fromId),
              commenterUsername: v?.from?.name ? String(v.from.name) : null,
              commentText: String(commentText),
            });
          } else {
            console.log("extractPostCommentEvents: feed comment dropped — missing field(s)", {
              field: "feed",
              item: v?.item,
              verb: v?.verb,
              hasFromId: !!fromId,
              hasCommentId: !!commentId,
              hasText: !!commentText,
              raw: JSON.stringify(v).slice(0, 200),
            });
          }
        }
      }
    }
  }

  return commentEvents;
}

function extractEmail(text) {
  const match = String(text || "").match(
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
  );
  return match ? match[0].toLowerCase() : null;
}

function extractPhone(text) {
  // Match common phone formats: +447123456789, 07123456789, (555) 123-4567, etc.
  const match = String(text || "").match(
    /(\+?\d[\d\s\-().]{7,}\d)/
  );
  if (!match) return null;
  const digits = match[1].replace(/\D/g, "");
  // At least 7 digits, at most 15
  if (digits.length < 7 || digits.length > 15) return null;
  return match[1].trim();
}
// normaliseTriggerText, parseKeywordFromPhrase, isStoryReplyTrigger,
// shouldUseStoryAutoDm, shouldUseKeywordAutoDm, isCommentReplyTrigger,
// shouldUseCommentAutoDm — imported from ./lib/conversationLogic.js

function isPlainTextMessage(messaging) {
  return !!String(messaging?.message?.text || "").trim();
}

function getStoryAutoDmText(cfg) {
  return String(cfg?.story_reply_auto_dm_text || "").trim();
}

function getKeywordAutoDmText(cfg) {
  return String(cfg?.keyword_auto_dm_text || "").trim();
}

function getCommentAutoDmText(cfg) {
  return String(cfg?.comment_reply_auto_dm_text || "").trim();
}

// ---------------------------
// BOT STYLE HELPERS
// ---------------------------
function detectThinkAboutIt(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("i'll think about it") ||
    t.includes("ill think about it") ||
    t.includes("i will think about it") ||
    t.includes("let me think") ||
    t.includes("need to think") ||
    t.includes("i'll get back to you") ||
    t.includes("ill get back to you") ||
    t.includes("i will get back to you")
  );
}

// ── Content safety ────────────────────────────────────────────────────────────
// Explicit profanities and phrases that should never appear in a bot reply.
// Covers common slurs and crude expressions. We also catch contextual phrases
// like "up my X" that have no place in a coaching conversation.
const SAFETY_BLOCKLIST = [
  /\bfuck(?:ing?|er|ed|s)?\b/i,
  /\bshit(?:ty|ter|s)?\b/i,
  /\bassed?\b/i,
  /\bass\s*hole/i,
  /\bbitch(?:es|ing)?\b/i,
  /\bcunt\b/i,
  /\bcock\b/i,
  /\bdick\b/i,
  /\bpussy\b/i,
  /\bbastard\b/i,
  /\bbollocks\b/i,
  /\bwank(?:er|ers|ing)?\b/i,
  /\btwat\b/i,
  /\bpiss(?:ed|ing)?\b/i,
  /\bup\s+my\s+\w+/i,   // catches "up my nuts", "up my ass", etc.
  /\bsuck\s+my\b/i,
];

function isUnsafeReply(text) {
  const t = String(text || "");
  return SAFETY_BLOCKLIST.some((re) => re.test(t));
}

// Returns true if the example assistant message looks like a legitimate coaching response
// (used to filter coach-entered examples before they reach the model as training data)
function isCleanExamplePair(userText, assistantText) {
  const u = String(userText || "");
  const a = String(assistantText || "");
  if (!u || !a) return false;
  if (isUnsafeReply(u) || isUnsafeReply(a)) return false;
  // Reject assistant examples that are implausibly short for a coaching DM (< 4 chars)
  if (a.trim().length < 4) return false;
  return true;
}

// isCasualGreeting, detectDirectProductRequest, detectPersonalQuestion,
// detectUnknownProductMention — imported from ./lib/conversationLogic.js

function detectOffTopicMessage(text, niche) {
  const t = String(text || "").toLowerCase().trim();
  if (!t || t.split(" ").length < 3) return false; // too short to judge

  // These topics are never in scope for any coaching niche
  const hardOffTopic = [
    // Finance / legal / accounting
    /\btax return\b/, /\bfiling (my|a) tax\b/, /\bself.?assessment\b/, /\bhmrc\b/, /\baccounting (help|advice|software)\b/,
    /\blegal (advice|help)\b/, /\bsolicitor\b/, /\blawyer\b/, /\blitigation\b/, /\bcontract (review|dispute)\b/,
    /\bvat return\b/, /\bcompany accounts\b/, /\bpayroll\b/, /\bbookkeeping\b/,
    // Medical / clinical
    /\bdiagnos(e|is|ing)\b/, /\bprescription\b/, /\bmedication\b/, /\bdoctor('?s)? (appointment|advice|referral)\b/,
    /\bsymptom(s)?\b.*\b(pain|ache|bleed|fever|rash|infection)\b/,
    /\bmental health (diagnosis|referral|prescription)\b/,
    // Home / trades
    /\bplumb(er|ing)\b/, /\bboiler (repair|fix|replace)\b/, /\belectrician\b/, /\broof(ing)? repair\b/,
    /\bcarpenter\b/, /\blandlord\b/, /\btenant (dispute|rights)\b/, /\bconveyancing\b/,
    // Tech support
    /\bmy (laptop|computer|phone|printer|wifi|router|iphone|android) (won'?t|isn'?t|doesn'?t|not) (work|connect|turn|start|boot)\b/,
    /\bpassword (reset|recover) (for|on) (my )?(gmail|facebook|instagram|apple|google|amazon|netflix)\b/,
    /\bhow (do i|to) (install|uninstall|update|download) (windows|macos|android|ios|excel|word)\b/,
    // Travel / logistics
    /\bflight (booking|cancel|refund|delay)\b/, /\bvisa application\b/, /\bpassport (renewal|application)\b/,
    /\bhotel (booking|cancel|refund)\b/,
    // Food delivery / retail
    /\b(uber|deliveroo|just.?eat|amazon) (order|delivery|refund|problem)\b/,
    // Clearly wrong number / confusion
    /\bwrong number\b/, /\bwho (are|is) (you|this)\b.*\b(again|please)\b/,
  ];

  if (hardOffTopic.some((re) => re.test(t))) return true;

  // For specific niches, also catch questions firmly outside that niche's domain
  // that aren't covered by general coaching knowledge
  const nicheOffTopic = {
    fitness: [
      /\bhow (do i|to) (file|submit|complete) (my )?(tax|vat|self.?assessment)\b/,
      /\b(investment|stock|share|crypto|forex) (advice|tip|strategy)\b/,
    ],
    money: [
      /\bworkout (plan|routine|programme)\b.*\bweight (loss|gain)\b/,
    ],
  };

  const nichePatterns = nicheOffTopic[niche] || [];
  if (nichePatterns.some((re) => re.test(t))) return true;

  return false;
}

// detectSalesPitch, detectGenuineLeadQuestion — imported from ./lib/conversationLogic.js

function sanitizeReply(text) {
  let out = String(text || "").trim();
  if (!out) return out;

  out = out.replace(/[—–]/g, " ");
  out = out.replace(/--+/g, " ");
  out = out.replace(/\s-\s/g, " ");

  out = out.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,
    ""
  );

  out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}
function detectStartProcessQuestion(text) {
  return /how do i get started|how do i start|what do i do next|what happens next|how does the process work|what happens after i book|how does onboarding work|how does it work|how does this work|hows it work|hows this work/i.test(
    String(text || "")
  );
}

function detectWhoItsForQuestion(text) {
  return /who is this for|who do you help|what kind of people is this for|is this for me|is this suitable for/i.test(
    String(text || "")
  );
}

function detectWhatYouSellQuestion(text) {
  return /what do you sell|what is it you sell|what do you actually help with|what do you do exactly/i.test(
    String(text || "")
  );
}
function detectWhatDoIGetQuestion(text) {
  return /what do i get|what do i actually get|what do i get if i join|what's included|whats included|what do i receive|what comes with it|what do i get with this/i.test(
    String(text || "")
  );
}
function stripWeakPhrases(text) {
  let out = String(text || "").trim();

  out = out.replace(/\bhappy to help\b/gi, "");
  out = out.replace(/\bi['’]d be happy to\b/gi, "");
  out = out.replace(/\blet me know\b/gi, "");
  out = out.replace(/\babsolutely\b/gi, "yeah");
  out = out.replace(/\bno worries at all\b/gi, "no worries");

  out = out.replace(/\s+([,!.?])/g, "$1");
  out = out.replace(/\(\s*\)/g, "");
  out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}
function stripOverusedFillers(text) {
  let out = String(text || "").trim();

  out = out.replace(/\bjust\s+and\b/gi, "and");
  out = out.replace(/\bjust\s*!/gi, "");
  out = out.replace(/\bjust\s*$/gi, "");
  out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}
function cleanObjectionReply(text) {
  let out = String(text || "").trim();
  if (!out) return out;

  out = out.replace(/^super simple[!.]?\s*/i, "");
  out = out.replace(/^totally get that[!.]?\s*/i, "");
  out = out.replace(/^i get that[!.]?\s*/i, "");
  out = out.replace(/^makes sense[!.]?\s*/i, "");
  out = out.replace(/^fair enough[!.]?\s*/i, "");
out = out.replace(/^,\s*/, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

function humaniseText(text) {
  let t = String(text || "").trim();
  if (!t) return t;

  t = t
    .replace(/\bgoing to\b/gi, "gonna")
    .replace(/\bwant to\b/gi, "wanna")
    .replace(/\bkind of\b/gi, "kinda");

  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}

function splitIntoMessages(text) {
  if (!text) return [];

  const raw = String(text).trim();
  if (!raw) return [];

  if (raw.includes("\n\n")) {
    return raw
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  if (raw.length <= 220) {
    return [raw];
  }

  const sentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
  const parts = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if (!current) {
      current = s;
      continue;
    }

    if ((current + " " + s).length <= 220) {
      current += " " + s;
    } else {
      parts.push(current.trim());
      current = s;
    }
  }

  if (current) parts.push(current.trim());

  return parts.length ? parts : [raw];
}
function parseExampleMessages(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];

  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const parsed = [];

  for (const block of blocks) {
    const match = block.match(/user:\s*([\s\S]*?)\nassistant:\s*([\s\S]*)/i);
    if (!match) continue;

    const user = String(match[1] || "").trim();
    const assistant = String(match[2] || "").trim();

    if (!user || !assistant) continue;

    parsed.push({ user, assistant });
  }

  // Filter out any pairs with inappropriate or malformed content
  return parsed.filter((ex) => isCleanExamplePair(ex.user, ex.assistant));
}

function extractOfferSection(raw, label, nextLabel = null) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNext = nextLabel
    ? nextLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : null;

  const regex = escapedNext
    ? new RegExp(`${escapedLabel}:\\s*([\\s\\S]*?)\\n\\n${escapedNext}:`, "i")
    : new RegExp(`${escapedLabel}:\\s*([\\s\\S]*)$`, "i");

  const match = text.match(regex);
  return match ? String(match[1] || "").trim() : "";
}
function extractSingleOfferSection(raw, label) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `${escapedLabel}:\\s*([\\s\\S]*?)(?=\\n\\n[A-Z][^\\n]*:|$)`,
    "i"
  );

  const match = text.match(regex);
  return match ? String(match[1] || "").trim() : "";
}
const VALID_NICHES = [
  "fitness", "money", "mindset", "nutrition", "relationship",
  "career", "life", "sales", "marketing", "leadership", "other", "generic",
];

// Maps free-text "Other" entries to a known niche if close enough
function mapOtherNiche(customText) {
  if (!customText) return "generic";
  const t = String(customText).toLowerCase();
  if (/fitness|gym|workout|weight|body|physique|strength|fat|muscle|transform|health|training/.test(t)) return "fitness";
  if (/money|business|revenue|income|client|sales|profit|financial|wealth|cash/.test(t)) return "money";
  if (/mindset|mental|anxiety|confidence|belief|self|stress|emotional|psychology/.test(t)) return "mindset";
  if (/nutrition|diet|food|eating|meal|gut|weight loss|macro|calories/.test(t)) return "nutrition";
  if (/relation|dating|love|partner|marriage|couple|divorce|breakup/.test(t)) return "relationship";
  if (/career|job|interview|promotion|workplace|profession|resume|cv/.test(t)) return "career";
  if (/sales|selling|close|convert|pipeline|cold outreach/.test(t)) return "sales";
  if (/market|brand|content|social media|funnel|ads|copy/.test(t)) return "marketing";
  if (/leader|manage|team|executive|director|founder|ceo/.test(t)) return "leadership";
  if (/life coach|personal develop|goal|habit|productivity|accountability/.test(t)) return "life";
  return "other";
}

function getEffectiveNiche(cfg) {
  const niche = String(cfg?.niche || "").trim().toLowerCase();
  if (VALID_NICHES.includes(niche)) return niche;
  // Legacy: if niche is "generic" or unrecognised, fall back
  return "generic";
}

function getNicheLabel(niche) {
  const labels = {
    fitness: "fitness coaching",
    money: "business and money coaching",
    mindset: "mindset coaching",
    nutrition: "nutrition coaching",
    relationship: "relationship coaching",
    career: "career coaching",
    life: "life coaching",
    sales: "sales coaching",
    marketing: "marketing coaching",
    leadership: "leadership coaching",
    other: "coaching",
    generic: "general coaching",
  };
  return labels[niche] || "general coaching";
}

function getNichePreset(niche) {
  if (niche === "fitness") {
    return {
      whatYouDo: "I help people get in shape properly with structure, accountability, and a plan they actually stick to.",
      whatTheyGet: "You get proper structure, accountability, clear targets, and support so you actually follow through instead of falling off after a week.",
      howItWorks: "You get started, we look at where you’re at now, what needs fixing, then everything gets built around that so you’ve got a clear plan and proper support.",
      whoItsFor: "It’s for people who are serious about getting in shape and want real structure, not people looking for a quick fix or random motivation.",
    };
  }
  if (niche === "money") {
    return {
      whatYouDo: "I help people tighten their offer, fix their messaging, and get more consistent clients instead of guessing and hoping.",
      whatTheyGet: "You get clarity on the offer, better positioning, direct support, and a proper path to getting clients more consistently.",
      howItWorks: "We look at where you’re at, what’s not converting, what needs tightening up, then build a clearer path so you can actually move properly.",
      whoItsFor: "It’s for people who want to make more money, get more clients, and stop drifting with no real structure.",
    };
  }
  if (niche === "mindset") {
    return {
      whatYouDo: "I help people break through the mental blocks stopping them from moving forward and build the mindset they actually need to get results.",
      whatTheyGet: "You get clarity on what’s holding you back, tools to shift it, and support to actually follow through instead of self-sabotaging.",
      howItWorks: "We identify the patterns and beliefs keeping you stuck, then work through them properly so you can actually move.",
      whoItsFor: "It’s for people who know what they need to do but keep getting in their own way.",
    };
  }
  if (niche === "nutrition") {
    return {
      whatYouDo: "I help people fix their relationship with food, build a sustainable diet, and actually get the results they’ve been chasing.",
      whatTheyGet: "You get a plan built around your life, proper guidance on what to eat and why, and support so you stay consistent.",
      howItWorks: "We look at where you’re at now, what’s not working, then build a proper eating plan around your lifestyle so it actually sticks.",
      whoItsFor: "It’s for people who are done with fad diets and want something that actually works long term.",
    };
  }
  if (niche === "relationship") {
    return {
      whatYouDo: "I help people build better relationships, improve how they communicate, and stop repeating the same patterns.",
      whatTheyGet: "You get tools to understand what’s really going on, how to handle it better, and proper support to actually change the dynamic.",
      howItWorks: "We look at what’s happening and why, then work through it properly so you’ve got real tools and not just surface fixes.",
      whoItsFor: "It’s for people who want to improve their relationship or how they show up in one, not people looking for a quick fix.",
    };
  }
  if (niche === "career") {
    return {
      whatYouDo: "I help people get clear on what they actually want from their career, make the right moves, and land where they want to be.",
      whatTheyGet: "You get clarity, a clear direction, and proper support to make the move without second-guessing yourself.",
      howItWorks: "We look at where you are, where you want to be, what’s in the way, then map a clear path and work through it properly.",
      whoItsFor: "It’s for people who feel stuck in their career or know they want more but don’t know how to get there.",
    };
  }
  if (niche === "life") {
    return {
      whatYouDo: "I help people get clear on what they actually want, build better habits, and start moving in the right direction.",
      whatTheyGet: "You get clarity, structure, proper accountability, and support so you actually follow through instead of going round in circles.",
      howItWorks: "We look at what you want, what’s in the way, and what needs to change, then build a clear plan and work through it together.",
      whoItsFor: "It’s for people who want to make real changes and are ready to do the work, not people looking for motivation alone.",
    };
  }
  if (niche === "sales") {
    return {
      whatYouDo: "I help people close more deals, improve their sales process, and stop losing leads they should be converting.",
      whatTheyGet: "You get a tighter process, better messaging, proper frameworks, and support so your close rate actually goes up.",
      howItWorks: "We look at where the deals are falling apart, fix the gaps, and build a process that converts more consistently.",
      whoItsFor: "It’s for people who know their product is good but struggle to convert leads into paying clients.",
    };
  }
  if (niche === "marketing") {
    return {
      whatYouDo: "I help people sharpen their messaging, build better content, and actually attract the right clients instead of just posting and hoping.",
      whatTheyGet: "You get clear positioning, a content strategy that works, and proper support to execute it consistently.",
      howItWorks: "We look at what you’re putting out, who it’s attracting, and what needs fixing, then rebuild it properly.",
      whoItsFor: "It’s for people who want their marketing to actually convert, not just get likes.",
    };
  }
  if (niche === "leadership") {
    return {
      whatYouDo: "I help leaders and founders get better at leading their teams, making decisions, and building something they’re actually proud of.",
      whatTheyGet: "You get clearer thinking, better tools for leading people, and a space to work through what’s actually going on.",
      howItWorks: "We look at where the friction is, what patterns are showing up, and work through them properly so you can lead more effectively.",
      whoItsFor: "It’s for leaders who want to be genuinely better at what they do, not just more productive.",
    };
  }
  if (niche === "other") {
    return {
      whatYouDo: "I help people get clarity, make a plan, and follow through properly.",
      whatTheyGet: "You get proper support, structure, and someone in your corner so you can actually get the result you’re after.",
      howItWorks: "We look at where you are, what needs to change, and build a clear path so you’re not just winging it.",
      whoItsFor: "It’s for people who are serious about making a real change and want proper support to do it.",
    };
  }
  return {
    whatYouDo: "I help people get a proper result with a clear plan, the right support, and a process that actually helps them follow through.",
    whatTheyGet: "You get proper support, structure, and guidance so you can stop guessing and actually move properly.",
    howItWorks: "We look at where you’re at, what needs fixing, and the best next steps so everything is clear and moving in the right direction.",
    whoItsFor: "It’s for people who want proper help and structure, not people just winging it.",
  };
}

function getStructuredOfferContext(cfg) {
  const raw = String(cfg?.offer_description || "").trim();
  const niche = getEffectiveNiche(cfg);
  const preset = getNichePreset(niche);

  return {
    what_you_do:
      String(cfg?.what_you_do || "").trim() ||
      extractOfferSection(raw, "What you do", "What they get") ||
      preset.whatYouDo,

    what_they_get:
      String(cfg?.what_they_get || "").trim() ||
      extractOfferSection(raw, "What they get", "Who it's for") ||
      preset.whatTheyGet,

    who_its_for:
      String(cfg?.who_its_for || "").trim() ||
      extractOfferSection(raw, "Who it's for", "How it works") ||
      preset.whoItsFor,

how_it_works:
  String(cfg?.how_it_works || "").trim() ||
  extractSingleOfferSection(raw, "How it works") ||
  preset.howItWorks,

    // Feature 2: multi-product support
    products:
      Array.isArray(cfg?.products) && cfg.products.length > 0
        ? cfg.products
        : null,

    // Unified booking links and products
    booking_items:
      Array.isArray(cfg?.booking_items) && cfg.booking_items.length > 0
        ? cfg.booking_items
        : null,
  };
}
function getDefaultFallbackExamples(niche = "generic") {
  if (niche === "fitness") {
    return [
      {
        user: "what do you actually help with",
        assistant:
          "I help people get in shape properly without guessing. Clear plan, accountability, proper support, and actually sticking to it.",
      },
      {
        user: "what do i get",
        assistant:
          "You get structure, accountability, and proper support so you're not just left trying to figure it out on your own.",
      },
      {
        user: "how does it work",
        assistant:
          "We look at where you're at now, what needs fixing, then everything gets set up properly around that.",
      },
      {
        user: "how much is it",
        assistant:
          "I can break the price down for you properly. Want me to send that over?",
      },
      {
        user: "sounds good",
        assistant:
          "good. want me to send the link so you can get started properly?",
      },
      {
        user: "send me the link",
        assistant:
          "here you go - pick a slot that works for you and we’ll get moving.",
      },
      {
        user: "i want it",
        assistant:
          "good. use this and get booked in.",
      },
      {
        user: "that’s expensive",
        assistant:
          "compared to what though? what were you expecting to pay?",
      },
      {
        user: "i’ll think about it",
        assistant:
          "fair. what’s the actual hesitation?",
      },
      {
        user: "not sure if it’s for me",
        assistant:
          "what part are you unsure about - the fit, the process, or the price?",
      },
    ];
  }

  if (niche === "money") {
    return [
      {
        user: "what do you actually help with",
        assistant:
          "I help people tighten their offer, fix the messaging, and get clients more consistently instead of guessing.",
      },
      {
        user: "what do i get",
        assistant:
          "You get clearer positioning, proper direction, and support so you stop drifting and actually move properly.",
      },
      {
        user: "how does it work",
        assistant:
          "We look at where you're at, what’s not converting, what needs fixing, then get a proper plan in place.",
      },
      {
        user: "how much is it",
        assistant:
          "I can break the price down properly for you. Want me to send it over?",
      },
      {
        user: "sounds good",
        assistant:
          "good. want me to send the link and get you moving on it?",
      },
      {
        user: "send me the link",
        assistant:
          "here you go - use that and get booked in.",
      },
      {
        user: "i want it",
        assistant:
          "good. get booked in and we’ll sort it properly.",
      },
      {
        user: "that’s expensive",
        assistant:
          "fair - what were you expecting to invest?",
      },
      {
        user: "i’ll think about it",
        assistant:
          "fair. what actually needs clearing up first?",
      },
      {
        user: "not sure if it’s for me",
        assistant:
          "what part are you unsure about - whether it works, whether it fits, or the investment?",
      },
    ];
  }

  return [
    {
      user: "what do you actually help with",
      assistant:
        "I help people get a proper result with clear structure and support instead of guessing their way through it.",
    },
    {
      user: "what do i get",
      assistant:
        "You get support, structure, and proper guidance so you can actually move properly.",
    },
    {
      user: "how does it work",
      assistant:
        "We look at where you're at, what needs fixing, then get a proper plan in place from there.",
    },
    {
      user: "how much is it",
      assistant:
        "I can break the price down for you properly. Want me to send it over?",
    },
    {
      user: "sounds good",
      assistant:
        "good. want me to send the link?",
    },
    {
      user: "send me the link",
      assistant:
        "here you go - pick what works for you and get booked in.",
    },
    {
      user: "i want it",
      assistant:
        "good. use the link and get started.",
    },
    {
      user: "that’s expensive",
      assistant:
        "fair. compared to what?",
    },
    {
      user: "i’ll think about it",
      assistant:
        "fair. what’s the actual hesitation?",
    },
    {
      user: "not sure if it’s for me",
      assistant:
        "what part are you unsure about?",
    },
  ];
}

async function getLeadMessageHistory(leadId, limit = 30) {
  const { data, error } = await supabase
    .from("messages")
    .select("direction,text,created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = (data || []).slice().reverse();
  return rows
    .map((m) => {
      const role = m.direction === "out" ? "assistant" : "user";
      const content = String(m.text || "").trim();
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);
}
async function sendInstagramTextMessage({
  accessToken,
  recipientId,
  text,
  useInstagramApi = false,
}) {
  const payload = {
    recipient: { id: recipientId },
    message: { text: String(text || "").trim() },
  };

  const baseUrl = useInstagramApi
    ? "https://graph.instagram.com/v21.0/me/messages"
    : "https://graph.facebook.com/v21.0/me/messages";

  return sendWithRetry(async () => {
    const sendResp = await fetch(
      `${baseUrl}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const sendData = await sendResp.json().catch(() => null);

    if (!sendResp.ok) {
      throw new Error(`Failed to send IG message: ${JSON.stringify(sendData)}`);
    }

    return { sendResp, sendData };
  });
}
async function getLeadMemory(leadId) {
  const { data, error } = await supabase
    .from("lead_memory")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function cleanMemoryField(value) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.toLowerCase() === "unknown") return null;
  if (out.toLowerCase() === "not provided") return null;
  if (out.toLowerCase() === "null") return null;
  return out;
}

function normaliseIntentLevel(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["cold", "warm", "hot"].includes(v)) return v;
  return null;
}

function mergeLeadMemory(existing, patch) {
  const toNumber = (value, fallback = 0) => {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };

  return {
    summary: cleanMemoryField(patch.summary) || existing?.summary || null,
    goal: cleanMemoryField(patch.goal) || existing?.goal || null,
    current_situation:
      cleanMemoryField(patch.current_situation) ||
      existing?.current_situation ||
      null,
    pain_points:
      cleanMemoryField(patch.pain_points) || existing?.pain_points || null,
    desired_outcome:
      cleanMemoryField(patch.desired_outcome) ||
      existing?.desired_outcome ||
      null,
    objection: cleanMemoryField(patch.objection) || existing?.objection || null,
    intent_level:
      normaliseIntentLevel(patch.intent_level) ||
      existing?.intent_level ||
      null,
    last_question_asked:
      cleanMemoryField(patch.last_question_asked) ||
      existing?.last_question_asked ||
      null,

    timeline: cleanMemoryField(patch.timeline) || existing?.timeline || null,
    event_name: cleanMemoryField(patch.event_name) || existing?.event_name || null,
    motivation: cleanMemoryField(patch.motivation) || existing?.motivation || null,
    budget: cleanMemoryField(patch.budget) || existing?.budget || null,
    trust_barrier:
      cleanMemoryField(patch.trust_barrier) || existing?.trust_barrier || null,

    last_cta_type:
      cleanMemoryField(patch.last_cta_type) || existing?.last_cta_type || null,
    last_cta_at: patch.last_cta_at || existing?.last_cta_at || null,

    booking_link_sent_count:
      typeof patch.booking_link_sent_count === "number"
        ? patch.booking_link_sent_count
        : existing?.booking_link_sent_count || 0,

    last_user_intent:
      cleanMemoryField(patch.last_user_intent) ||
      existing?.last_user_intent ||
      null,

    last_bot_reply_type:
      cleanMemoryField(patch.last_bot_reply_type) ||
      existing?.last_bot_reply_type ||
      null,

    conversation_state:
      cleanMemoryField(patch.conversation_state) ||
      existing?.conversation_state ||
      null,

    cta_attempts:
      typeof patch.cta_attempts === "number"
        ? patch.cta_attempts
        : typeof existing?.cta_attempts === "number"
        ? existing.cta_attempts
        : 0,

    last_cta_response:
      cleanMemoryField(patch.last_cta_response) ||
      existing?.last_cta_response ||
      null,

    answered_price_count:
      typeof patch.answered_price_count === "number"
        ? patch.answered_price_count
        : toNumber(existing?.answered_price_count, 0),

    answered_offer_count:
      typeof patch.answered_offer_count === "number"
        ? patch.answered_offer_count
        : toNumber(existing?.answered_offer_count, 0),

    answered_process_count:
      typeof patch.answered_process_count === "number"
        ? patch.answered_process_count
        : toNumber(existing?.answered_process_count, 0),

    answered_who_its_for_count:
      typeof patch.answered_who_its_for_count === "number"
        ? patch.answered_who_its_for_count
        : toNumber(existing?.answered_who_its_for_count, 0),
  };
}

async function upsertLeadMemory({ leadId, clientId, patch, existing }) {
  const merged = mergeLeadMemory(existing, patch);

  const { data, error } = await supabase
    .from("lead_memory")
    .upsert(
      {
        lead_id: leadId,
        client_id: clientId,
        ...merged,
      },
      { onConflict: "lead_id" }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function extractLeadMemory({
  lead,
  historyMessages,
  existingMemory,
  currentMessage,
}) {
  if (!openai) return existingMemory || null;

  const recent = (historyMessages || []).slice(-12);

  const messages = [
    {
      role: "system",
content: `
You extract structured sales memory from Instagram DMs.

Return ONLY valid JSON.

Rules:
- Keep values short and factual
- Do not invent anything
- If unknown, use null
- intent_level must be one of: "cold", "warm", "hot", or null
- summary should be 1 short sentence max
- timeline = any time marker or deadline like "september", "summer", "in 8 weeks"
- event_name = any event or reason with a date attached like "holiday", "wedding", "photoshoot", "birthday", "event"
- motivation = emotional reason like "confidence", "look better", "feel good", "prove to myself"
- budget = what they expected / can afford if mentioned
- trust_barrier = if they seem unsure whether this will work, whether it's for them, or whether to trust it
- last_question_asked should only capture the assistant's latest meaningful question if one exists

Return exactly this shape:
{
  "summary": null,
  "goal": null,
  "current_situation": null,
  "pain_points": null,
  "desired_outcome": null,
  "objection": null,
  "intent_level": null,
  "last_question_asked": null,
  "timeline": null,
  "event_name": null,
  "motivation": null,
  "budget": null,
  "trust_barrier": null
}
`.trim(),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
existing_memory: existingMemory
  ? {
      summary: existingMemory.summary,
      goal: existingMemory.goal,
      current_situation: existingMemory.current_situation,
      pain_points: existingMemory.pain_points,
      desired_outcome: existingMemory.desired_outcome,
      objection: existingMemory.objection,
      intent_level: existingMemory.intent_level,
      last_question_asked: existingMemory.last_question_asked,
      timeline: existingMemory.timeline,
      event_name: existingMemory.event_name,
      motivation: existingMemory.motivation,
      budget: existingMemory.budget,
      trust_barrier: existingMemory.trust_barrier,
    }
  : null,
          latest_user_message: currentMessage,
          recent_messages: recent,
          lead_meta: {
            stage: lead?.stage || null,
            call_completed: !!lead?.call_completed,
            booking_sent: !!lead?.booking_sent,
          },
        },
        null,
        2
      ),
    },
  ];

  try {
const resp = await withTimeout(
  openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0,
    max_tokens: 220,
    response_format: { type: "json_object" },
  }),
  8000
);

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (!text) return existingMemory || null;

    const parsed = JSON.parse(text);

    return mergeLeadMemory(existingMemory, {
      summary: parsed.summary,
      goal: parsed.goal,
      current_situation: parsed.current_situation,
      pain_points: parsed.pain_points,
      desired_outcome: parsed.desired_outcome,
      objection: parsed.objection,
      intent_level: parsed.intent_level,
      last_question_asked: parsed.last_question_asked,
      timeline: parsed.timeline,
      event_name: parsed.event_name,
      motivation: parsed.motivation,
      budget: parsed.budget,
      trust_barrier: parsed.trust_barrier,    
});
  } catch (e) {
    console.warn("lead memory extraction failed:", e?.message || e);
    return existingMemory || null;
  }
}
function detectPriceQuestion(text) {
  return /price|cost|how much|what'?s the price|how much is it|what do you charge|pricing/i.test(
    String(text || "")
  );
}

function detectHighIntent(text) {
  return /ready to buy|i want it|send me the link|book me in|where do i sign up|how do i join|let's do it|lets do it|i'm ready|im ready|sign me up|i want to join|i want to book/i.test(
    String(text || "")
  );
}

function detectSoftIntent(text) {
  return /sounds good|interesting|tell me more|how does it work|can i start|what do i do next|send details|i'm interested|im interested/i.test(
    String(text || "")
  );
}
function detectExplicitBookingLinkRequest(text) {
  return /send me the link|booking link|book me in|where do i book|send the booking link|can you send the link/i.test(
    String(text || "")
  );
}

function detectOfferQuestion(text) {
  return /what is this|what's this|whats this|what is it|what's it|whats it|what do you actually do|what do you help with|tell me more|how does this work|what is included|what do i get|what do i actually get|what do i get if i join|what comes with it|so what is it then|what actually is it/i.test(
    String(text || "")
  );
}

function detectQuestionAfterLink(text) {
  return /what is this|what's this|whats this|how much|price|cost|how does it work|tell me more|what do you mean|what is included|what do i get|what do i actually get|what happens after i book|who is this for/i.test(
    String(text || "")
  );
}

function detectObjectionType(text) {
  const t = String(text || "").toLowerCase();

  if (
    t.includes("think about it") ||
    t.includes("let me think") ||
    t.includes("i'll get back to you") ||
    t.includes("ill get back to you")
  ) {
    return "think_about_it";
  }

  if (
    t.includes("too expensive") ||
    t.includes("bit much") ||
    t.includes("out of budget") ||
    t.includes("cant afford") ||
    t.includes("can't afford")
  ) {
    return "price";
  }

  if (
    t.includes("not sure") ||
    t.includes("unsure") ||
    t.includes("don’t know") ||
    t.includes("dont know")
  ) {
    return "uncertain";
  }

  if (
    t.includes("busy right now") ||
    t.includes("not now") ||
    t.includes("bad time") ||
    t.includes("later")
  ) {
    return "timing";
  }

  return null;
}
function inferIntentScore(text, leadMemory) {
  const t = String(text || "").toLowerCase();
  let score = 0;

  if (detectHighIntent(t)) score += 4;
  if (detectSoftIntent(t)) score += 2;
  if (detectPriceQuestion(t)) score += 1;

  if (/\bok\b|\bokay\b|\byes\b|\byeah\b|\bsure\b/.test(t)) score += 1;

  if (
    t.includes("not sure") ||
    t.includes("maybe") ||
    t.includes("i'll think about it") ||
    t.includes("let me think")
  ) {
    score -= 2;
  }

  if (leadMemory?.intent_level === "warm") score += 1;
  if (leadMemory?.intent_level === "hot") score += 2;

  return score;
}

function hasUsefulQualification(leadMemory) {
  return !!(
    leadMemory?.goal ||
    leadMemory?.current_situation ||
    leadMemory?.pain_points ||
    leadMemory?.desired_outcome ||
    leadMemory?.timeline ||
    leadMemory?.event_name ||
    leadMemory?.motivation
  );
}
function detectUserIntent(text) {
  const t = String(text || "").trim().toLowerCase();

  if (!t) return "unknown";
  if (detectExplicitBookingLinkRequest(t)) return "booking_link_request";
  if (detectStartProcessQuestion(t)) return "start_process_question";
  if (detectWhoItsForQuestion(t)) return "who_its_for_question";
  if (detectWhatDoIGetQuestion(t)) return "what_do_i_get_question";
  if (detectWhatYouSellQuestion(t) || detectOfferQuestion(t)) return "offer_question";
  if (detectPriceQuestion(t)) return "price_question";
  if (detectThinkAboutIt(t)) return "think_about_it";
  if (detectHighIntent(t)) return "high_intent";
  if (detectSoftIntent(t)) return "soft_intent";

  return "general";
}

function getReplyTypeFromTurnStrategy(turnStrategy) {
  const type = String(turnStrategy?.type || "");

  if (
    type === "send_booking_link_now" ||
    type === "soft_close_to_booking"
  ) {
    return "booking_cta";
  }

  if (
    type === "answer_price_after_cta" ||
    type === "handle_price_then_cta"
  ) {
    return "price_answer";
  }

  if (
    type === "answer_offer_question_after_cta" ||
    type === "answer_what_you_sell_after_cta" ||
    type === "answer_what_do_i_get_after_cta"
  ) {
    return "offer_answer";
  }

  if (type === "answer_start_process_after_cta") {
    return "process_answer";
  }

  if (type === "answer_who_its_for_after_cta") {
    return "who_its_for_answer";
  }

  if (type === "handle_think_about_it") {
    return "objection_probe";
  }

  if (type === "ask_qualifying_question") {
    return "qualification_question";
  }

  if (
    type === "answer_question_after_cta" ||
    type === "post_call_support" ||
    type === "nudge_forward"
  ) {
    return "general_answer";
  }

  return "general_answer";
}

function preventRepeatedReplyType(turnStrategy, leadMemory) {
  const nextReplyType = getReplyTypeFromTurnStrategy(turnStrategy);
  const lastReplyType = String(leadMemory?.last_bot_reply_type || "");

  if (!lastReplyType || nextReplyType !== lastReplyType) {
    return turnStrategy;
  }

  if (nextReplyType === "booking_cta") {
    return {
      ...turnStrategy,
      type: "answer_question_after_cta",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "qualification_question") {
    return {
      ...turnStrategy,
      type: "nudge_forward",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "objection_probe") {
    return {
      ...turnStrategy,
      type: "nudge_forward",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "price_answer") {
    return {
      ...turnStrategy,
      type: "answer_question_after_cta",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "offer_answer") {
    return {
      ...turnStrategy,
      type: "answer_question_after_cta",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "process_answer") {
    return {
      ...turnStrategy,
      type: "answer_question_after_cta",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  if (nextReplyType === "who_its_for_answer") {
    return {
      ...turnStrategy,
      type: "answer_question_after_cta",
      shouldSendBookingLink: false,
      forcedVariation: true,
    };
  }

  return turnStrategy;
}

function buildReplyTrackingPatch(existingMemory, turnStrategy) {
  const replyType = getReplyTypeFromTurnStrategy(turnStrategy);

  return {
    last_bot_reply_type: replyType,
    answered_price_count:
      replyType === "price_answer"
        ? (existingMemory?.answered_price_count || 0) + 1
        : existingMemory?.answered_price_count || 0,

    answered_offer_count:
      replyType === "offer_answer"
        ? (existingMemory?.answered_offer_count || 0) + 1
        : existingMemory?.answered_offer_count || 0,

    answered_process_count:
      replyType === "process_answer"
        ? (existingMemory?.answered_process_count || 0) + 1
        : existingMemory?.answered_process_count || 0,

    answered_who_its_for_count:
      replyType === "who_its_for_answer"
        ? (existingMemory?.answered_who_its_for_count || 0) + 1
        : existingMemory?.answered_who_its_for_count || 0,
  };
}
function normaliseForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTokenSet(text) {
  return new Set(normaliseForSimilarity(text).split(" ").filter(Boolean));
}

function getOverlapRatio(a, b) {
  const setA = getTokenSet(a);
  const setB = getTokenSet(b);

  if (!setA.size || !setB.size) return 0;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }

  return overlap / Math.max(setA.size, setB.size);
}

function isReplyTooSimilar(newReply, previousAssistantMessages = [], turnStrategyType = "") {
  const recentAssistantMessages = previousAssistantMessages
    .filter((m) => m?.role === "assistant")
    .slice(-3)
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);

  if (!newReply) return false;

  const strictTypes = [
    "answer_price_after_cta",
    "handle_price_then_cta",
    "answer_offer_question_after_cta",
    "answer_what_you_sell_after_cta",
    "answer_what_do_i_get_after_cta",
    "answer_start_process_after_cta",
    "answer_who_its_for_after_cta",
  ];

  const threshold = strictTypes.includes(String(turnStrategyType || "")) ? 0.84 : 0.76;

  return recentAssistantMessages.some((oldReply) => {
    const ratio = getOverlapRatio(newReply, oldReply);
    return ratio >= threshold;
  });
}
function looksIncompleteReply(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;

  const badEndings = [
    "just",
    "and",
    "or",
    "if",
    "but",
    "so",
    "because",
    "you can",
    "get started, just",
    "book through the link i sent earlier just",
  ];

  if (badEndings.some((x) => t.endsWith(x))) return true;

  if (t.length < 12) return true;

  return false;
}

function getFallbackReply({ turnStrategy, cfg, leadMemory }) {
  const bookingUrl = cfg?.booking_url || "";
  const structured = getStructuredOfferContext(cfg);

  const map = {
    answer_price_after_cta: [
      (() => { const p = Array.isArray(cfg?.products) ? cfg.products.find((p) => p?.price) : null; return p?.price ? `it’s ${p.price}` : `i can break the pricing down properly for you`; })(),
    ],
answer_offer_question_after_cta: [
  `${getEffectiveWhatYouDo(cfg)}`,
],

answer_what_you_sell_after_cta: [
  `${getEffectiveWhatYouDo(cfg)}`,
],
    answer_what_do_i_get_after_cta: structured.what_they_get
      ? [structured.what_they_get]
      : [],
    answer_start_process_after_cta: structured.how_it_works
      ? [structured.how_it_works]
      : [`you book in, we go through where you're at, then we get everything set up properly from there`],
    answer_who_its_for_after_cta: structured.who_its_for
      ? [structured.who_its_for]
      : [`it’s for people who want proper help and structure, not people just winging it`],
handle_think_about_it: [
  `thats fair - what’s the main thing holding you back?`,
  `all good - what do you need to see before you can decide properly?`,
  `got you - is it price, timing or not being fully sure yet?`,
],
ask_qualifying_question: [
  `what’s the main thing you want to fix right now?`,
  `what’s been the hardest part for you so far?`,
  `what are you actually trying to get sorted?`,
  `what’s the main result you want from this?`,
  `what’s not working properly for you at the minute?`,
  `what have you been struggling to sort on your own?`,
],

nudge_forward: [
  `got you - what’s the main thing stopping you from moving on it now?`,
  `okay - are you just looking around or do you actually want help with it?`,
  `thats fair - what’s the bit you’re still not sold on?`,
  `got you - is it more the price, the timing, or are you just not fully sure yet?`,
  `okay - what’s actually holding you back from sorting it properly?`,
  `thats fair - do you actually want help with this or are you still just weighing it up?`,
  `got you - what needs clearing up before you’d move on it?`,
  `thats fair - what’s the main hesitation right now?`,
],
soft_close_to_booking: bookingUrl
  ? [getEscalatedBookingReply(bookingUrl, leadMemory, "soft")]
  : [`makes sense - best next step is we go through it properly`],
send_booking_link_now: bookingUrl
  ? [getEscalatedBookingReply(bookingUrl, leadMemory, "normal")]
  : [`best thing is get booked in and we’ll go through it properly`],
  };

  const options = map[turnStrategy?.type] || [];

  if (!options.length) return null;

  return options[Math.floor(Math.random() * options.length)];
}
function buildDeterministicReply({ turnStrategy, cfg }) {
  const offerDescription = String(cfg?.offer_description || "").trim();
  const firstProductPrice = Array.isArray(cfg?.products) ? (cfg.products.find((p) => p?.price)?.price || "") : "";
  const offerPrice = firstProductPrice || "";
  const structured = getStructuredOfferContext(cfg);
const whatYouDo = getEffectiveWhatYouDo(cfg);
  const whatTheyGet = structured.what_they_get;
  const whoItsFor = structured.who_its_for;
  const howItWorks = structured.how_it_works;

  if (
    turnStrategy?.type === "answer_price_after_cta" ||
    turnStrategy?.type === "handle_price_then_cta"
  ) {
    if (offerPrice) {
      return `it’s ${offerPrice}`;
    }
  }

if (
  turnStrategy?.type === "answer_offer_question_after_cta" ||
  turnStrategy?.type === "answer_what_you_sell_after_cta"
) {
  if (whatYouDo) {
    return whatYouDo;
  }

return getEffectiveWhatYouDo(cfg);
}

if (turnStrategy?.type === "answer_what_do_i_get_after_cta") {
  if (whatTheyGet) {
    return whatTheyGet;
  }

  if (offerDescription) {
    return `you get the support, structure and guidance needed to do this properly`;
  }
}

  if (turnStrategy?.type === "answer_start_process_after_cta") {
    if (howItWorks) {
      return howItWorks;
    }

    if (offerDescription) {
      return `you book in, we go through where you're at, then we get everything set up properly from there`;
    }
  }

  if (turnStrategy?.type === "answer_who_its_for_after_cta") {
    if (whoItsFor) {
      return whoItsFor;
    }

    if (offerDescription) {
      return `it’s for people who want proper help and structure, not people just winging it`;
    }
  }

  if (turnStrategy?.type === "warm_greeting") return "hey! how can i help?";
  if (turnStrategy?.type === "send_product_link_now") {
    // Try to find a product URL in cfg
    const products = Array.isArray(cfg?.products) ? cfg.products : [];
    const withUrl = products.find((p) => p?.url);
    if (withUrl?.url) return `here’s the link: ${withUrl.url}`;
    if (cfg?.booking_url) return `here’s the link: ${cfg.booking_url}`;
    return null;
  }

  return null;
}
function deriveConversationState({ lead, leadMemory, userIntent }) {
  if (lead?.call_completed) return "post_call";

  const bookingSent =
    !!lead?.booking_sent ||
    !!leadMemory?.last_cta_at ||
    (leadMemory?.booking_link_sent_count || 0) > 0;

  const hasQualification = hasUsefulQualification(leadMemory);
  const hasGoal = !!leadMemory?.goal;
  const hasObstacle =
    !!leadMemory?.pain_points ||
    !!leadMemory?.objection ||
    !!leadMemory?.trust_barrier;
  const hasReasonWhyNow = !!leadMemory?.timeline || !!leadMemory?.event_name;
  const intent = String(leadMemory?.intent_level || "");

  if (bookingSent) {
    if (
      userIntent === "price_question" ||
      userIntent === "offer_question" ||
      userIntent === "what_do_i_get_question" ||
      userIntent === "start_process_question" ||
      userIntent === "who_its_for_question" ||
      userIntent === "think_about_it"
    ) {
      return "post_cta_followup";
    }

    return "booking_cta_sent";
  }

  if (userIntent === "think_about_it" || leadMemory?.objection) {
    return "objection_handling";
  }

  if (intent === "hot" && hasQualification) {
    return "ready_to_close";
  }

  if (intent === "warm" && hasGoal && hasObstacle) {
    return "warmed";
  }

  if (hasQualification && hasReasonWhyNow) {
    return "well_qualified";
  }

  if (hasQualification) {
    return "qualified";
  }

  return "discovery";
}

function decideTurnStrategyFromIntent({
  userIntent,
  conversationState,
  lead,
  leadMemory,
  text,
  bookingUrl,
  isFirstMessage,
  products,
}) {
  // ── GREETING RULE ───────────────────────────────────────────────────────────
  // On the very first message, if the lead is just saying hi, warm up first.
  // Never jump to qualifying questions on a greeting — build rapport first.
  if (isFirstMessage && isCasualGreeting(text)) {
    return { type: "warm_greeting", intentScore: 0, shouldSendBookingLink: false };
  }

  // ── DIRECT PRODUCT / LINK REQUEST ───────────────────────────────────────────
  // If the lead is explicitly asking for a product or programme link, send it
  // immediately. Don't ask another question when they're ready to receive.
  if (detectDirectProductRequest(text, products)) {
    return { type: "send_product_link_now", intentScore: 3, shouldSendBookingLink: false };
  }

  const intentScore = inferIntentScore(text, leadMemory);

  const bookingRecentlySent =
    !!lead?.booking_sent ||
    !!leadMemory?.last_cta_at ||
    (leadMemory?.booking_link_sent_count || 0) > 0;

  const hasBookingUrl = !!bookingUrl;
  const hasQualification = hasUsefulQualification(leadMemory);
  const hasGoal = !!leadMemory?.goal;
  const hasObstacle =
    !!leadMemory?.pain_points ||
    !!leadMemory?.objection ||
    !!leadMemory?.trust_barrier;
  const hasWhyNow = !!leadMemory?.timeline || !!leadMemory?.event_name;
  const enoughWarmth = hasGoal && (hasObstacle || hasWhyNow);

  if (conversationState === "post_call") {
    return {
      type: "post_call_support",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (
    userIntent === "booking_link_request" &&
    hasBookingUrl &&
    !bookingRecentlySent
  ) {
    return {
      type: "send_booking_link_now",
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (userIntent === "think_about_it" || detectObjectionType(text)) {
    return {
      type: "handle_think_about_it",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (userIntent === "price_question") {
    return {
      type: bookingRecentlySent
        ? "answer_price_after_cta"
        : "handle_price_then_cta",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

if (userIntent === "offer_question") {
  return {
    type: bookingRecentlySent
      ? "answer_offer_question_after_cta"
      : "answer_what_you_sell_after_cta",
    intentScore,
    shouldSendBookingLink: false,
  };
}

  if (userIntent === "what_do_i_get_question") {
    return {
      type: "answer_what_do_i_get_after_cta",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (userIntent === "start_process_question") {
    return {
      type: "answer_start_process_after_cta",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (userIntent === "who_its_for_question") {
    return {
      type: "answer_who_its_for_after_cta",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (
    (userIntent === "high_intent" || intentScore >= 4) &&
    hasBookingUrl &&
    !bookingRecentlySent &&
    enoughWarmth
  ) {
    return {
      type: "send_booking_link_now",
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (
    (conversationState === "ready_to_close" ||
      conversationState === "well_qualified" ||
      (userIntent === "soft_intent" && enoughWarmth)) &&
    hasBookingUrl &&
    !bookingRecentlySent
  ) {
    return {
      type: "soft_close_to_booking",
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (!hasQualification || conversationState === "discovery") {
    return {
      type: "ask_qualifying_question",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  return {
    type: "nudge_forward",
    intentScore,
    shouldSendBookingLink: false,
  };
}

function deriveLeadStage({
  lead,
  turnStrategy,
  leadMemory,
}) {
  if (lead?.call_completed) return "call_completed";

  if (turnStrategy?.type === "send_booking_link_now") return "booking_sent";
  if (turnStrategy?.type === "soft_close_to_booking") return "booking_sent";
  if (turnStrategy?.type === "handle_price_then_cta") return "high_intent";
  if (turnStrategy?.type === "handle_think_about_it") return "high_intent";

  if (
    leadMemory?.intent_level === "hot" ||
    turnStrategy?.intentScore >= 4
  ) {
    return "high_intent";
  }

  if (
    leadMemory?.intent_level === "warm" ||
    turnStrategy?.intentScore >= 2
  ) {
    return "warm";
  }

  if (
    leadMemory?.goal ||
    leadMemory?.current_situation ||
    leadMemory?.pain_points ||
    leadMemory?.desired_outcome ||
    leadMemory?.timeline ||
    leadMemory?.event_name ||
    leadMemory?.motivation
  ) {
    return "warm";
  }

  return lead?.stage || "new";
}

async function updateLeadTracking(leadId, patch) {
  const { data, error } = await supabase
    .from("leads")
    .update(patch)
    .eq("id", leadId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

function replyContainsBookingLink(reply, bookingUrl) {
  if (!reply || !bookingUrl) return false;
  return String(reply).includes(String(bookingUrl));
}
async function saveLearnedExample({
  clientId,
  leadId,
  userMessage,
  assistantMessage,
}) {
  const cleanUser = String(userMessage || "").trim();
  const cleanAssistant = String(assistantMessage || "").trim();

  if (!cleanUser || !cleanAssistant) return null;

  // Safety gate: never store examples that contain inappropriate content.
  // Also rejects pairs that are clearly not coaching-related.
  if (isUnsafeReply(cleanUser) || isUnsafeReply(cleanAssistant)) {
    console.warn("learned_example skipped: inappropriate content detected", {
      clientId,
      userMessage: cleanUser.slice(0, 80),
      assistantMessage: cleanAssistant.slice(0, 80),
    });
    return null;
  }

  // Reject implausibly short assistant messages (< 6 chars) — not useful training data
  if (cleanAssistant.length < 6) return null;

  const { data, error } = await supabase
    .from("learned_examples")
    .insert({
      client_id: clientId,
      lead_id: leadId,
      user_message: cleanUser,
      assistant_message: cleanAssistant,
      source: "auto",
      approved: false,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
function hasStrongCustomExamples(raw) {
  const parsed = parseExampleMessages(raw);
  return parsed.length >= 3;
}

function getEffectiveTone(cfg) {
  return cleanMemoryField(cfg?.tone) || "direct";
}

function getEffectiveStyle(cfg) {
  return cleanMemoryField(cfg?.style) || "short, punchy";
}

function getEffectiveVocabulary(cfg) {
  return cleanMemoryField(cfg?.vocabulary) || "casual, blunt, UK DM style";
}

function getEscalatedBookingReply(bookingUrl, leadMemory, mode = "normal") {
  if (!bookingUrl) return null;

  const attempts = Number(leadMemory?.cta_attempts || 0);
  const anchor = buildMemoryAnchor(leadMemory);

  if (mode === "soft") {
    if (attempts <= 0) {
      return anchor
        ? `${bookingUrl}\n\nif you want to get this moving ${anchor}, grab a slot that works for you`
        : `makes sense - use this and grab a slot that works for you ${bookingUrl}`;
    }

    if (attempts === 1) {
      return anchor
        ? `${bookingUrl}\n\nbest next step is getting booked in if you want to sort this ${anchor}`
        : `best next step is just get booked in here and we’ll go through it properly ${bookingUrl}`;
    }

    return anchor
      ? `${bookingUrl}\n\nif you’re serious about sorting this ${anchor}, get booked in`
      : `${bookingUrl}\n\nif you want to do it properly, book in and we’ll get it moving`;
  }

  if (attempts <= 0) {
    return anchor
      ? `${bookingUrl}\n\nif you want to sort this ${anchor}, use this and pick a time that works for you`
      : `${bookingUrl}\n\nuse this and pick a time that works for you`;
  }

  if (attempts === 1) {
    return anchor
      ? `${bookingUrl}\n\nbook in here if you want to get this handled ${anchor}`
      : `${bookingUrl}\n\nbook in here and we’ll get you sorted properly`;
  }

  return anchor
    ? `${bookingUrl}\n\nif you’re serious about sorting this ${anchor}, book in and let’s get moving`
    : `${bookingUrl}\n\nif you’re serious about sorting it, book in and let’s get moving`;
}

function getObjectionFollowUpReply(objectionText, leadMemory, cfg) {
  const t = String(objectionText || "").toLowerCase();
  const attempts = Number(leadMemory?.cta_attempts || 0);

  if (t.includes("price") || t.includes("expensive") || t.includes("cost")) {
    if (attempts >= 2) return "fair, but what were you actually expecting to pay for this?";
    return "fair, what were you expecting to pay?";
  }

  if (t.includes("not sure") || t.includes("unsure")) {
    if (attempts >= 2) return "what part are you still not sold on?";
    return "what part are you unsure about?";
  }

  if (t.includes("think")) {
    if (attempts >= 2) return "fair, but what actually needs clearing up before you move on it?";
    return "all good, what’s the main thing you need to be clear on first?";
  }

  if (t.includes("timing") || t.includes("busy") || t.includes("later")) {
    if (attempts >= 2) return "fair - is it genuinely bad timing or are you still not fully sold?";
    return "fair, is it bad timing right now or are you not fully sold yet?";
  }

  if (attempts >= 2) {
    return "fair, what’s actually stopping you from moving on it?";
  }

  return "fair, what’s the main thing holding you back?";
}

function buildMemoryAnchor(leadMemory) {
  const timeline = String(leadMemory?.timeline || "").trim();
  const eventName = String(leadMemory?.event_name || "").trim();
  const goal = String(leadMemory?.goal || "").trim();
  const motivation = String(leadMemory?.motivation || "").trim();

  if (eventName && timeline) {
    return `for ${eventName} in ${timeline}`;
  }

  if (eventName) {
    return `for ${eventName}`;
  }

  if (timeline && goal) {
    return `${goal} by ${timeline}`;
  }

  if (timeline) {
    return `by ${timeline}`;
  }

  if (motivation) {
    return `especially if ${motivation}`;
  }

  if (goal) {
    return `with ${goal}`;
  }

  return "";
}

function buildWarmCloseFromMemory(bookingUrl, leadMemory) {
  const anchor = buildMemoryAnchor(leadMemory);

  if (!bookingUrl) return null;

  if (anchor) {
    return `${bookingUrl}\n\nif you want to get this moving ${anchor}, get booked in and we’ll map it out properly`;
  }

  return `${bookingUrl}\n\nget booked in and we’ll go through it properly`;
}


function getLastAssistantMessages(historyMessages = [], n = 4) {
  return historyMessages
    .filter((m) => m?.role === "assistant")
    .slice(-n)
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
}

async function generateAiReply({
  cfg,
  lead,
  historyMessages,
  leadMemory,
  turnStrategy,
  postCallMode,
  asksPrice,
  highIntent,
  bookingUrl,
  thinkAboutIt,
  userText,
  conversationGap,
}) {
  if (!openai) return null;
  const now = Date.now();
  global.aiCalls = global.aiCalls.filter((t) => now - t < 60000);

  if (global.aiCalls.length >= MAX_AI_CALLS_PER_MIN) {
    console.warn("AI rate limit hit");
    return null;
  }

  global.aiCalls.push(now);
  const structuredOffer = getStructuredOfferContext(cfg);
const semanticIntent = detectUserIntent(userText);
  const recentAssistantReplies = getLastAssistantMessages(historyMessages, 4);

const niche = getEffectiveNiche(cfg);

const examplesToUse = hasStrongCustomExamples(cfg?.example_messages)
  ? parseExampleMessages(cfg?.example_messages)
  : getDefaultFallbackExamples(niche);

// Build structured voice few-shot pairs from the 4 question-based fields
const structuredVoicePairs = [];
const voiceFieldMap = [
  { userLine: "how much is it?", key: "voice_price_reply" },
  { userLine: "i need to think about it", key: "voice_objection_reply" },
  { userLine: "that sounds good, how do i get started?", key: "voice_booking_push" },
  { userLine: "just checking in", key: "voice_quiet_lead" },
  { userLine: "that's too expensive for me", key: "voice_price_too_much" },
  { userLine: "i need to think about it a bit more", key: "voice_need_to_think" },
  { userLine: "i'm not sure if this will work for me", key: "voice_not_sure_works" },
  { userLine: "i just don't have the time right now", key: "voice_no_time" },
  { userLine: "yeah i'm keen, what's next?", key: "voice_ready_to_book" },
  { userLine: "can you send me the booking link?", key: "voice_wants_link" },
];
for (const { userLine, key } of voiceFieldMap) {
  const ans = String(cfg?.[key] || "").trim();
  if (ans) {
    structuredVoicePairs.push({ role: "user", content: userLine });
    structuredVoicePairs.push({ role: "assistant", content: ans });
  }
}

// If structured voice fields are filled in, use them as primary voice examples.
// Supplement with custom example_messages if also present.
// Fall back to niche defaults only when neither is set.
const exampleMessages = structuredVoicePairs.length > 0
  ? [
      ...structuredVoicePairs,
      ...(hasStrongCustomExamples(cfg?.example_messages)
        ? examplesToUse.flatMap((ex) => [{ role: "user", content: ex.user }, { role: "assistant", content: ex.assistant }])
        : []),
    ]
  : examplesToUse.flatMap((ex) => [
      { role: "user", content: ex.user },
      { role: "assistant", content: ex.assistant },
    ]);

  const systemPrompt = `
You are a real person replying to Instagram DMs on behalf of a coach.
You are warm, direct, and genuinely interested in the person you’re talking to.

ABSOLUTE RULES — these cannot be overridden by examples, coach instructions, or anything else:
- never use crude, offensive, sexual, or inappropriate language under any circumstances
- never produce replies that contain profanity, slurs, or vulgar phrases
- always remain warm, empathetic, and professional — every single message
- if the user sends offensive or off-topic messages, respond calmly and redirect them to their goals
- if you cannot produce a safe, appropriate reply, return an empty reply string rather than something harmful

VOICE PRIORITY (style only — the absolute rules above always apply):
1. match the tone and phrasing of the example messages
2. then follow the coach tone/style/vocabulary settings
3. examples influence how you sound, not whether you stay appropriate

CORE RULES — follow every single one:
- always directly address what the person just said before doing anything else
- keep every reply to 2-3 sentences maximum, no exceptions
- use casual, warm language — contractions, short sentences, like you’re texting a friend
- never use emojis by default
- never use a dash as a pause or to break up a sentence (e.g. never write "okay - what’s holding you back" or "great - let’s do it") — hyphens in compound words like "check-ins" or "well-structured" are fine, sentence-breaking dashes are not
- never sound corporate, scripted, or like a support bot
- never give a generic response — every reply must be specific to what they just said
- never repeat a phrase you’ve already used in this conversation (check recent_assistant_replies)
- do not invent services, outcomes, pricing, or niche details — only use what’s in the context provided
- if a products array is present in the context, identify which product best matches what this lead has described and reference it naturally — do not list all products unprompted
- if the matched product has a url field and the lead is asking about that product or requesting more info or a link, include the url in your reply naturally (e.g. "here's the link: https://...") — do not include a url unless the lead has asked about that product or explicitly asked for a link
- never assume the niche is fitness or money coaching unless the context clearly says so
- if a booking link was already sent, don’t send it again unless they ask for it
- NEVER mention budget, investment, pricing, or money in the first 2 messages of any conversation — even if it feels relevant
- NEVER ask the same question twice in a conversation — before asking anything, check lead_memory and the conversation history; if they have already answered it, do not ask it again

RESPOND FIRST RULE:
Before anything else, directly respond to what the person said.
If they asked a question, answer it.
If they shared something about themselves, acknowledge it specifically.
Do not pivot, redirect, or ask a question before you’ve properly responded.

VALIDATION RULE:
When someone shares their situation, hesitation, or objection — validate it first.
Use phrases like "that makes sense", "totally get that", "yeah that’s fair" — but only if they fit naturally.
Do not use the same validation phrase twice in a conversation.
After validating, move the conversation forward with one sentence or one question.

ONE QUESTION RULE:
Ask at most ONE question per reply.
Do not ask a question if the person gave you a direct answer or is clearly ready.
Only ask a question when you genuinely need more info or to gently move things forward.
Good questions: "what’s the main thing holding you back?", "how long has that been going on?", "what does your current routine look like?", "is it timing or price?"
Bad questions: "what do you think?", "how are you feeling about it?", "tell me more"

GREETING RULE:
When the lead’s message is a casual greeting like "hey", "hi", or "how are you" and there is no goal or intent yet:
- respond warmly and naturally: "hey! how can I help?" or "hey, what’s on your mind?" or similar
- do NOT immediately ask about their goals or jump to qualifying questions
- build rapport first — one warm reply, then wait for them to share more
- the turn_strategy will be "warm_greeting" — honour it

GAP AWARENESS RULE:
Use the conversation_gap field to adjust how you open your reply:
- "first_message": this is their first ever message — greet them naturally, no re-opener needed
- "same_session": under 6 hours since their last message — continue naturally, no re-opener needed
- "medium_gap": 6–24 hours since their last message — open with a subtle acknowledgment before continuing, e.g. "hey, good to hear from you" or "good to have you back" — then carry on from where you left off
- "long_gap": 24 hours or more since their last message — open with a warm re-opener e.g. "hey, welcome back" or "good to hear from you again", then briefly reference what was discussed before (check lead_memory and conversation history) to re-establish context
Do NOT acknowledge the gap if conversation_gap is "same_session" or "first_message". The re-opener should always feel natural, not scripted.

DIRECT PRODUCT REQUEST RULE:
When the turn_strategy is "send_product_link_now" OR the lead is directly asking for a product, programme, or link:
- send the relevant product link or booking link immediately — do not ask another question first
- use the products array to find the best match and include the url naturally
- if no specific product matches, send the booking_url as the next best thing
- never make them ask twice for something they already asked for

MEMORY RULE:
Before writing any reply, check lead_memory for what the person has already told you.
Memory is not optional — it is how you avoid sounding like a script and make every reply feel personal.

- if lead_memory.goal is set: you already know what they want — never ask again, weave it into your reply whenever it’s relevant
- if lead_memory.event_name or lead_memory.timeline is set: connect it naturally to whatever they’re currently asking about (e.g. if they ask about price and you know they want to be ready before August, tie those together: "starts from £x — plenty of time before August")
- if lead_memory.pain_points is set: acknowledge it when the topic comes up, don’t make them repeat themselves
- if lead_memory.current_situation is set: use it to make replies feel specific to them, not generic
- if lead_memory.motivation is set: bring it back when they seem hesitant or need a reason to move forward
- if lead_memory.objection is set: you already know their hesitation — address it without making them re-explain

The golden rule: if the person mentioned something earlier in the conversation, connect it to what they’re asking now.
Never ask someone what their goal is if they already told you.
Never give a generic answer when you have their specific context in memory.

CONVERSATION HISTORY RULE:
The full conversation history is in the messages above — read it before writing anything.
- if the lead mentioned they struggle with something earlier (e.g. consistency, time, motivation), reference it naturally rather than asking again
- never ask a question that has already been answered earlier in this conversation — check the history first
- build on the rapport that’s already been established — the lead should feel like you remember them, not like you’re starting fresh each time
- if they shared personal context (their goals, situation, job, schedule) in a previous message, use those details to personalise your reply
- the conversation history is your primary source of personalisation — use it

THREE-PHASE CONVERSATION RULE:
Read the phase from high_intent, asks_price, and lead_memory.cta_attempts in the context.

PHASE 1 — warm up (high_intent: false, asks_price: false, cta_attempts: 0):
Your only job is to understand their situation and build real rapport.
- ask genuine, curious questions about their goals, struggles, and what’s held them back
- do NOT mention calls, booking, pricing, budget, investment, or money — not even indirectly
- do NOT ask "what’s your budget?" or "what were you thinking of investing?" — ever in Phase 1
- do NOT push toward a CTA of any kind
- only ask questions about: their goal, their current situation, their challenges, what they’ve already tried, what’s held them back
- good Phase 1 questions:
  - "what’s been the main thing stopping you?"
  - "how long have you been thinking about making a change?"
  - "what does your current [routine / situation] look like?"
  - "what have you already tried?"
- stay here until they show interest in the offer itself

PHASE 2 — middle intent (client asks about coaching or what’s involved, but no strong buying signal yet):
The person is warming up. You can mention a call once — naturally, not as a push.
- suggest a quick chat once, framed as low-pressure: "would it help to jump on a quick call and just see if it’s a good fit?"
- if they ignore the call suggestion and keep asking questions, drop it completely and just keep answering helpfully
- do NOT repeat the call suggestion again until they show a stronger signal (asking price, saying it sounds good, asking how to start)
- check lead_memory.cta_attempts: if cta_attempts >= 1 and high_intent is still false, you have already suggested a call — do not suggest it again, just be helpful
- the goal in Phase 2 is to keep them engaged and informed, not to push

PHASE 3 — high intent (high_intent: true OR asks_price: true):
The person is ready. Now actively guide them toward booking.
- clear signals: asking about price, asking what’s included, saying "that sounds good", asking "how do I start", asking about next steps
- use memory here — connect their goal or timeline to the answer (e.g. "it’s £x/month — and given you want to [goal] before [event], timing is actually good right now")
- guide them naturally to the booking link: "want me to send you the link so we can go through it properly?"
- set should_send_booking_link to true when they confirm they want to proceed

OBJECTION RULE:
When someone hesitates, says it’s expensive, says they’ll think about it, or isn’t sure:
- validate what they said first — don’t skip this
- then ask one sharp question to find the real issue
- do not jump straight to the booking link
- do not reassure them with hollow positivity
- good responses: "yeah that’s fair, what part are you unsure about?", "totally get that — is it the price or the timing?", "makes sense, what would help you feel more confident?"
- do not immediately push back on the objection — acknowledge it genuinely first

ANSWER INTENT RULE:
The person may phrase things awkwardly. Answer what they meant, not just what they typed.
- "what is it" → explain the offer simply
- "what do I get" → explain deliverables
- "how does it work" → explain the process
- "who is it for" → explain fit
- "how much" → give the price directly
- "I’ll think about it" → validate, then ask what they need to make a decision

PROACTIVE PRODUCT INTRODUCTION RULE:
When the lead's message touches on a topic that is semantically related to a saved product or service — even if they don't use the exact product name:
- match by topic, theme, and description — not just exact keywords: e.g. someone mentioning "blush" or "makeup" should connect to a beauty product; someone asking about "staying consistent" or "building a routine" should connect to a coaching programme; someone mentioning "losing weight" or "getting lean" should connect to a fitness product
- use the product description and who_its_for fields to judge relevance, not just the name
- recognise this as a signal to introduce the product naturally — not as a hard sell
- use framing like "I actually have [product name] that could help with that — want me to send you the link?"
- if the lead shows interest or asks for it, include the url in your reply
- lean toward sharing the link rather than holding back
- if the conversation topic matches but you are not certain, introduce the product gently and let them decide
- NEVER list all products at once — only the most relevant one
- if the lead mentions a specific product by name that does NOT exist in the products array, set should_pause_for_coach: true and return an empty reply

PRODUCT vs BOOKING LINK RULE:
Products and booking links are completely different — never confuse them:
- if an item in booking_items has type "product": use it as a product recommendation — "I have this [name] that might help"
- if an item in booking_items has type "booking": use it ONLY for booking a call — "want to jump on a quick call?"
- never send a product URL as a booking link or vice versa
- only send any link ONCE per conversation unless the lead asks for it again — check recent_assistant_replies to see if the link was already sent

PERSONAL QUESTION RULE:
If the lead asks about personal details of the coach that are not in the provided context (e.g. where they live, their appearance, their personal life, family, relationships, daily routine outside coaching):
- do NOT guess or make anything up
- return an empty reply string: ""
- set should_pause_for_coach: true in your response
- the system will flag this for the coach to answer personally

COACH CONTEXT RULE:
- use main_result to understand the core promised outcome
- use best_fit_leads when answering "is this for me?" questions
- use not_a_fit to avoid positioning the offer for the wrong people
- use common_objections to answer hesitation more sharply
- use closing_triggers to know when to move toward booking
- use urgency_reason naturally when timing matters
- use trust_builders when someone seems skeptical
- use faq for direct practical questions
- only use the parts relevant to the current message — never dump everything at once

CTA ESCALATION RULE:
- if cta_attempts is 0, keep closes light: "want me to send the link?"
- if cta_attempts is 1, be a bit more direct: "ready to get started?"
- if cta_attempts is 2 or more, be clear and decisive — don’t dance around it
- never repeat the exact same CTA wording
- if last_cta_response shows hesitation, address that before closing again

BOOKING LINK CLOSING RULE:
When should_send_booking_link is true, add one short personalised sentence after the link.
Use what the client explicitly said — check lead_memory in this order:
1. lead_memory.goal — if set, reference it directly: "we’ll get you [goal]", "looking forward to helping you [goal]"
2. lead_memory.event_name — if set, tie it to timing: "plenty of time to sort it before [event_name]"
3. lead_memory.desired_outcome — if set, use that as the closing hook
4. If none of the above are set, use a generic close: "looking forward to helping you reach your goals"
Only reference something the client actually said. Never assume or invent a goal they didn’t mention.

CONTACT COLLECTION RULE:
Only applies when contact_collection_enabled is true in the context.
- if email_already_collected is false: once you have answered their question and the conversation is warm (not first message), ask naturally for their email — "what's the best email to reach you on?" or "drop me your email and I'll send over the details"
- if phone_already_collected is false and you already have their email: you may ask for their number in a later message — "and what's the best number for you?"
- never ask for email AND phone in the same message
- if email_already_collected and phone_already_collected are both true: never ask again
- never ask for contact details in Phase 1 (high_intent: false, cta_attempts: 0)
- keep the ask short and casual, not formal

NICHE RULE:
- niche is "${niche}" (${getNicheLabel(niche)})
- use terminology and framing natural for that niche — fitness coaches talk about training, results, body change; money coaches talk about clients, revenue, offers; mindset coaches talk about beliefs, patterns, clarity; nutrition coaches talk about food, diet, consistency; relationship coaches talk about communication, patterns, connection; career coaches talk about direction, opportunities, progression; life coaches talk about goals, habits, clarity; sales coaches talk about pipeline, conversion, close rate; marketing coaches talk about messaging, content, attracting clients; leadership coaches talk about team, decisions, culture
- match the language to what someone in that niche would actually say

Return ONLY valid JSON in this exact shape:
{
  "reply": "string",
  "reply_type": "answer|answer_then_nudge|question|close|objection",
  "should_send_booking_link": false,
  "should_pause_for_coach": false
}
  `.trim();
const coachSystemPrompt = String(cfg?.system_prompt || "").trim();

const finalSystemPrompt =
  coachSystemPrompt.length >= 120
    ? `${systemPrompt}

COACH STYLE NOTES (tone, vocabulary, and personality guidance only — the absolute rules above still apply):
${coachSystemPrompt}`
    : systemPrompt;
const context = {
  user_message: userText,
  niche,
  niche_label: getNicheLabel(niche),
  semantic_intent: semanticIntent,
  lead_stage: lead?.stage || null,
  call_completed: !!lead?.call_completed,
  booking_sent: !!lead?.booking_sent,
  booking_url_present: !!bookingUrl,
  booking_url: bookingUrl || null,

  offer_price: (Array.isArray(cfg?.products) ? cfg.products.find((p) => p?.price)?.price : null) || null,
  offer_description: cfg?.offer_description || null,
  what_you_do: getEffectiveWhatYouDo(cfg),
  what_they_get: structuredOffer.what_they_get || null,
  who_its_for: structuredOffer.who_its_for || null,
  how_it_works: structuredOffer.how_it_works || null,
  products: structuredOffer.products || null,
  booking_items: structuredOffer.booking_items || null,

  main_result: String(cfg?.main_result || "").trim() || null,
  best_fit_leads: String(cfg?.best_fit_leads || "").trim() || null,
  not_a_fit: String(cfg?.not_a_fit || "").trim() || null,
  common_objections: String(cfg?.common_objections || "").trim() || null,
  closing_triggers: String(cfg?.closing_triggers || "").trim() || null,
  urgency_reason: String(cfg?.urgency_reason || "").trim() || null,
  trust_builders: String(cfg?.trust_builders || "").trim() || null,
  faq: String(cfg?.faq || "").trim() || null,

  tone: getEffectiveTone(cfg),
  style: getEffectiveStyle(cfg),
  vocabulary: getEffectiveVocabulary(cfg),

  post_call_mode: !!postCallMode,
  asks_price: !!asksPrice,
  high_intent: !!highIntent,
  think_about_it: !!thinkAboutIt,

  example_messages_present: examplesToUse.length,
  recent_assistant_replies: recentAssistantReplies,

  lead_memory: leadMemory
    ? {
        summary: leadMemory.summary || null,
        goal: leadMemory.goal || null,
        current_situation: leadMemory.current_situation || null,
        pain_points: leadMemory.pain_points || null,
        desired_outcome: leadMemory.desired_outcome || null,
        objection: leadMemory.objection || null,
        intent_level: leadMemory.intent_level || null,
        last_question_asked: leadMemory.last_question_asked || null,
        timeline: leadMemory.timeline || null,
        event_name: leadMemory.event_name || null,
        motivation: leadMemory.motivation || null,
        budget: leadMemory.budget || null,
        trust_barrier: leadMemory.trust_barrier || null,
        last_cta_type: leadMemory.last_cta_type || null,
        booking_link_sent_count: leadMemory.booking_link_sent_count || 0,
        last_user_intent: leadMemory.last_user_intent || null,
        last_bot_reply_type: leadMemory.last_bot_reply_type || null,
        conversation_state: leadMemory.conversation_state || null,
        cta_attempts: leadMemory.cta_attempts || 0,
        last_cta_response: leadMemory.last_cta_response || null,
      }
    : null,

  turn_strategy: turnStrategy
    ? {
        type: turnStrategy.type,
        intentScore: turnStrategy.intentScore ?? null,
        shouldSendBookingLink: !!turnStrategy.shouldSendBookingLink,
      }
    : null,

  contact_collection_enabled: !!cfg?.contact_collection_enabled,
  email_already_collected: !!lead?.email,
  phone_already_collected: !!lead?.phone,

  conversation_gap: conversationGap || "first_message",
};

  const messages = [
{
  role: "system",
  content: finalSystemPrompt,
},
    ...exampleMessages,
    ...(historyMessages || []),
    {
      role: "user",
      content: JSON.stringify(context, null, 2),
    },
  ];

  try {
const resp = await withTimeout(
  openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.55,
    max_tokens: 220,
    response_format: { type: "json_object" },
  }),
  8000
);

    const raw = resp?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);   
 } catch {
      return null;
    }
if (!parsed || typeof parsed.reply !== "string") {
  return null;
}
    let reply = String(parsed?.reply || "").trim();
    if (!reply) return null;

reply = sanitizeReply(
  cleanObjectionReply(
    stripOverusedFillers(
      stripWeakPhrases(reply)
    )
  )
);

    if (looksIncompleteReply(reply)) return null;

    // Hard safety gate — never send a reply that contains inappropriate content,
    // regardless of what the model produced. Log it and return null so the
    // deterministic fallback system handles the turn instead.
    if (isUnsafeReply(reply)) {
      console.error("⚠️ SAFETY BLOCK: AI reply contained inappropriate content and was suppressed.", {
        clientId: cfg?.client_id,
        reply,
      });
      return null;
    }

    return {
      reply,
      reply_type: String(parsed?.reply_type || "answer"),
      should_send_booking_link: !!parsed?.should_send_booking_link,
      should_pause_for_coach: !!parsed?.should_pause_for_coach,
    };
  } catch (e) {
    console.warn("⚠️ OpenAI error:", e?.message || e);
    return null;
  }
}
// ---------------------------
// MANUAL TAKEOVER + GLOBAL PAUSE HELPERS
// ---------------------------
async function setLeadManualOverride({ leadId, clientId, enabled, reason, actor }) {
  const patch = {
    manual_override: !!enabled,
    manual_override_reason: reason ? String(reason).slice(0, 200) : null,
    manual_override_by: actor,
    manual_override_at: nowIso(),
    // Clear notification flag when override is cleared so next pause triggers a new email
    ...(enabled === false && { coach_notified_at: null }),
  };

  let q = supabase.from("leads").update(patch).eq("id", leadId);
  if (clientId) q = q.eq("client_id", clientId);

  const { data, error } = await q.select("*").single();
  if (error) throw error;

  // Clear from in-memory set so a future pause sends a fresh notification
  // (coachNotifiedLeads is defined later in the file but is always initialised by runtime)
  if (enabled === false && typeof coachNotifiedLeads !== "undefined") coachNotifiedLeads.delete(leadId);

  return data;
}

function getEffectiveWhatYouDo(cfg) {
  const raw = String(cfg?.what_you_do || "").trim();
  const niche = getEffectiveNiche(cfg);
  const preset = getNichePreset(niche);

  if (raw) {
    const weakPhrases = [
      "tailored service",
      "help people get results",
      "support and guidance",
      "journey",
      "transform lives",
      "reach their goals",
    ];

    const lower = raw.toLowerCase();
    const weakHit = weakPhrases.some((p) => lower.includes(p));

    if (raw.length >= 35 && !weakHit) {
      return raw;
    }
  }

  return preset.whatYouDo;
}

async function setClientBotPaused({ clientId, enabled, reason, actor }) {
  const patch = {
    bot_paused: !!enabled,
    bot_paused_reason: reason ? String(reason).slice(0, 200) : null,
    bot_paused_by: actor,
    bot_paused_at: nowIso(),
  };

  const { data, error } = await supabase
    .from("client_configs")
    .update(patch)
    .eq("client_id", clientId)
    .select("*")
    .single();

  if (error) throw error;

  // Bulk-update manual_override on all leads for this client
  try {
    await supabase
      .from("leads")
      .update({
        manual_override: !!enabled,
        manual_override_reason: enabled ? "Global pause" : null,
        manual_override_by: actor,
        manual_override_at: nowIso(),
      })
      .eq("client_id", clientId);
  } catch (e) {
    console.warn("setClientBotPaused: bulk lead override failed", e?.message || e);
  }

  return data;
}

async function lookupIgName(accessToken, igPsid, { useInstagramApi = false, coachIgUserId = null } = {}) {
  if (!useInstagramApi) {
    // Facebook Login: look up by PSID via graph.facebook.com
    try {
      const resp = await fetch(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(igPsid)}?fields=name&access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await resp.json().catch(() => ({}));
      return data?.name || null;
    } catch {
      return null;
    }
  }

  // Instagram Login:
  // Stage 1 — User Profile API (works after the user has messaged; username may be restricted)
  try {
    const profileResp = await fetch(
      `https://graph.instagram.com/v21.0/${encodeURIComponent(igPsid)}?fields=name,username&access_token=${encodeURIComponent(accessToken)}`
    );
    const profileData = await profileResp.json().catch(() => ({}));
    if (profileData?.username) return profileData.username;
    if (profileData?.name) return profileData.name;
  } catch {}

  // Stage 2 — Conversations API: fetch the conversation thread and read from.username
  // from the most recent message.
  if (coachIgUserId) {
    try {
      const convResp = await fetch(
        `https://graph.instagram.com/v21.0/${encodeURIComponent(coachIgUserId)}/conversations` +
        `?user_id=${encodeURIComponent(igPsid)}&fields=messages&access_token=${encodeURIComponent(accessToken)}`
      );
      const convData = await convResp.json().catch(() => ({}));
      const messageId = convData?.data?.[0]?.messages?.data?.[0]?.id;
      if (messageId) {
        const msgResp = await fetch(
          `https://graph.instagram.com/v21.0/${encodeURIComponent(messageId)}?fields=from&access_token=${encodeURIComponent(accessToken)}`
        );
        const msgData = await msgResp.json().catch(() => ({}));
        const fromName = msgData?.from?.username || msgData?.from?.name;
        if (fromName) return fromName;
      }
    } catch {}
  }

  // Stage 3 — graph.facebook.com PSID lookup (the original Facebook Login endpoint).
  // Instagram Login tokens can also resolve IGSIDs here and it returns `name` reliably
  // for account types where Stage 1 and Stage 2 return nothing (e.g. personal accounts).
  try {
    const fbResp = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(igPsid)}?fields=name&access_token=${encodeURIComponent(accessToken)}`
    );
    const fbData = await fbResp.json().catch(() => ({}));
    if (fbData?.name) return fbData.name;
  } catch {}

  return null;
}

// ---------------------------
// STRIPE DB HELPERS
// ---------------------------
async function updateClientStripeStatus(clientId, patch) {
  const safePatch = {
    ...patch,
    stripe_updated_at: nowIso(),
  };

  const { data, error } = await supabase
    .from("client_configs")
    .update(safePatch)
    .eq("client_id", clientId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function findClientIdByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;

  const { data, error } = await supabase
    .from("client_configs")
    .select("client_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .single();

  if (error) return null;
  return data?.client_id || null;
}

async function getClientConfig(clientId) {
  const { data, error } = await supabase
    .from("client_configs")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) throw error;
  return data; // null if no config row exists
}

function signInstagramState(clientId) {
  return jwt.sign(
    {
      type: "instagram_connect",
      client_id: clientId,
    },
    COACH_JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function verifyInstagramState(state) {
  const decoded = jwt.verify(state, COACH_JWT_SECRET);
  const validTypes = ["instagram_connect", "instagram_signup"];
  if (!decoded || !validTypes.includes(decoded.type)) {
    throw new Error("invalid state");
  }
  if (decoded.type === "instagram_connect" && !decoded.client_id) {
    throw new Error("invalid state");
  }
  return decoded;
}

// ── Facebook Login for Business chain helpers ──────────────────────────────
function signFbChainState({ clientId, isNew }) {
  return jwt.sign(
    { type: "facebook_chain", client_id: clientId, is_new: !!isNew },
    COACH_JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function verifyFbChainState(state) {
  const decoded = jwt.verify(state, COACH_JWT_SECRET);
  if (!decoded || decoded.type !== "facebook_chain" || !decoded.client_id) {
    throw new Error("invalid facebook chain state");
  }
  return decoded;
}

function buildFacebookOAuthUrl(state) {
  const url = new URL("https://www.facebook.com/v23.0/dialog/oauth");
  url.searchParams.set("client_id", META_APP_ID);
  url.searchParams.set("redirect_uri", META_FB_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  // Approved scopes only. pages_manage_metadata and pages_messaging are NOT requested —
  // they are not approved and not needed since comment webhooks are delivered via the
  // Instagram per-account subscription (instagram object) rather than the FB Page feed.
  url.searchParams.set("scope", "instagram_manage_comments,pages_show_list,pages_read_engagement,public_profile");
  // config_id pre-configures permissions in Meta Developer Dashboard — use if set
  if (META_CONFIG_ID) url.searchParams.set("config_id", META_CONFIG_ID);
  url.searchParams.set("state", state);
  return url.toString();
}

app.get("/coach/api/instagram/connect-url", requireCoach, async (req, res) => {
  try {
    if (!INSTAGRAM_APP_ID || !META_REDIRECT_URI) {
      return safeJson(res, 500, { error: "Instagram app env vars not configured" });
    }

    const state = signInstagramState(req.coach.client_id);

    const authUrl = new URL("https://www.instagram.com/oauth/authorize");
    authUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
    authUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_messages");
    authUrl.searchParams.set("enable_fb_login", "0");
    authUrl.searchParams.set("force_reauth", "1");
    authUrl.searchParams.set("state", state);

    return safeJson(res, 200, {
      ok: true,
      url: authUrl.toString(),
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});
// ------------------------------------------------------------------
// subscribeIgWebhook — shared helper used at connect time and by the
// resubscribe / diagnostic endpoints.
// ------------------------------------------------------------------
async function subscribeIgWebhook(accessToken, igUserId) {
  // Use the numeric user ID explicitly rather than the `me` alias —
  // some Instagram API versions don't resolve `me` for this endpoint.
  const url = `https://graph.instagram.com/v21.0/${encodeURIComponent(igUserId)}/subscribed_apps`;

  // `messages` — DMs delivered via Instagram Business Login.
  // `comments` — post comments delivered via Instagram webhook (instagram object).
  //   Requires instagram_manage_comments or instagram_business_manage_comments permission
  //   to be approved on the app AND subscribed at the app level in Meta Developer Dashboard
  //   (App → Webhooks → instagram object → comments field).
  //   Do NOT use the Facebook Page /subscribed_apps endpoint for this — it requires
  //   pages_manage_metadata which is not an approved permission for this app.
  const body = new URLSearchParams({ subscribed_fields: "messages,comments" }).toString();

  console.log("subscribeIgWebhook: calling", { url, body });

  const resp = await fetch(`${url}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const httpStatus = resp.status;
  const data = await resp.json().catch(() => ({}));

  console.log("subscribeIgWebhook: response", { igUserId, httpStatus, data });

  return { ok: resp.ok && data?.success === true, httpStatus, data };
}

// ------------------------------------------------------------------
// subscribeFbPageWebhook — subscribe a Facebook Page to feed (comment)
// webhook events via graph.facebook.com/{page_id}/subscribed_apps.
// Only subscribes `feed` (post comments/replies) — NOT `messages`,
// which requires pages_messaging (not an approved permission).
// Requires pages_read_engagement on the page access token.
// This is the mechanism that actually delivers real comment events;
// the Instagram per-account subscription (/subscribed_apps on
// graph.instagram.com) returns success for `comments` but does not
// deliver real comment events for Instagram Business Login accounts.
// ------------------------------------------------------------------
async function subscribeFbPageWebhook(pageToken, pageId) {
  const url = `https://graph.facebook.com/v23.0/${encodeURIComponent(pageId)}/subscribed_apps`;
  // `feed` covers post comments and comment replies.
  // Do NOT include `messages` — requires pages_messaging (not approved).
  const body = new URLSearchParams({ subscribed_fields: "feed" }).toString();

  console.log("subscribeFbPageWebhook: calling", { url, pageId, fields: "feed" });

  const resp = await fetch(`${url}?access_token=${encodeURIComponent(pageToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const httpStatus = resp.status;
  const data = await resp.json().catch(() => ({}));

  console.log("subscribeFbPageWebhook: response", { pageId, httpStatus, data });

  return { ok: resp.ok && data?.success === true, httpStatus, data };
}



// Re-subscribe webhook for the current Instagram Login account (no OAuth round-trip needed).
// Also self-heals a corrupted ig_user_id (float64 precision bug) using the /me API.
app.post("/coach/api/instagram/resubscribe", requireCoach, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from("ig_accounts")
      .select("id, ig_user_id, page_access_token")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .is("page_id", null)
      .order("created_at", { ascending: false })
      .limit(1);

    const acc = Array.isArray(rows) ? rows[0] : null;
    if (!acc?.page_access_token) {
      return safeJson(res, 404, { error: "No active Instagram Login account found" });
    }

    // If the caller knows the correct webhook recipient ID (IGBID), accept it as an
    // override. This handles the ASID vs IGBID namespace mismatch: the /me endpoint
    // returns the App-Scoped User ID but the webhook delivers the Instagram Business
    // Account ID — they differ and the webhook recipient ID is authoritative for routing.
    const overrideId = req.body?.webhook_recipient_id
      ? String(req.body.webhook_recipient_id).trim()
      : null;

    // Get authoritative user ID from /me (string, no float64 precision issue)
    const meResp = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(acc.page_access_token)}`
    );
    const meData = await meResp.json().catch(() => ({}));
    const meId = meData?.id ? String(meData.id) : null;
    const correctId = overrideId || meId;
    const correctUsername = meData?.username || null;

    let idFixed = false;
    if (correctId && correctId !== acc.ig_user_id) {
      console.log("resubscribe: correcting ig_user_id", {
        stored: acc.ig_user_id,
        correct: correctId,
        source: overrideId ? "webhook_recipient_override" : "me_endpoint",
      });
      await supabase
        .from("ig_accounts")
        .update({ ig_user_id: correctId, ...(correctUsername ? { ig_username: correctUsername } : {}) })
        .eq("id", acc.id);
      idFixed = true;
    }

    const igUserId = correctId || acc.ig_user_id;
    const { ok, httpStatus, data } = await subscribeIgWebhook(acc.page_access_token, igUserId);

    if (!ok) {
      return safeJson(res, 502, { error: "Webhook subscription failed", httpStatus, detail: data, idFixed });
    }

    return safeJson(res, 200, { ok: true, detail: data, idFixed, ig_user_id: igUserId, me_id: meId });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// Diagnostic: returns the raw Instagram API response for the subscribed_apps call
// and also checks what the current subscription looks like.
// Call: GET /coach/api/instagram/subscription-debug
app.get("/coach/api/instagram/subscription-debug", requireCoach, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from("ig_accounts")
      .select("ig_user_id, page_access_token, ig_username")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .is("page_id", null)
      .order("created_at", { ascending: false })
      .limit(1);

    const acc = Array.isArray(rows) ? rows[0] : null;
    if (!acc?.page_access_token) {
      return safeJson(res, 404, { error: "No active Instagram Login account found" });
    }

    // Check current subscription status (GET)
    const getUrl = `https://graph.instagram.com/v21.0/${encodeURIComponent(acc.ig_user_id)}/subscribed_apps?access_token=${encodeURIComponent(acc.page_access_token)}`;
    const getResp = await fetch(getUrl);
    const getCurrentData = await getResp.json().catch(() => ({}));

    // Attempt subscription (POST)
    const { ok, httpStatus, data: postData } = await subscribeIgWebhook(acc.page_access_token, acc.ig_user_id);

    return safeJson(res, 200, {
      account: { ig_user_id: acc.ig_user_id, ig_username: acc.ig_username },
      current_subscription: { httpStatus: getResp.status, data: getCurrentData },
      subscribe_attempt: { ok, httpStatus, data: postData },
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// Backfill ig_name for existing leads that still show the raw IGSID placeholder or NULL.
// Runs the same two-stage lookup (User Profile API → Conversations API) used for new leads.
// Safe to call multiple times — skips leads that already have a resolved name.
// Single-lead fetch — used by the dashboard to poll until ig_name resolves from 'Loading...'
app.get("/coach/api/leads/:leadId", requireCoach, async (req, res) => {
  try {
    const { data: lead, error } = await supabase
      .from("leads")
      .select("id,ig_psid,ig_name,stage,booking_sent,call_completed,manual_override,manual_override_reason,manual_override_by,manual_override_at,last_inbound_at,last_outbound_at,email,phone,followup_sent")
      .eq("id", req.params.leadId)
      .eq("client_id", req.coach.client_id)
      .single();

    if (error || !lead) return safeJson(res, 404, { error: "Lead not found" });
    return safeJson(res, 200, { ok: true, lead });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/coach/api/leads/backfill-names", requireCoach, async (req, res) => {
  try {
    // Get the coach's active Instagram Login account
    const { data: accRows } = await supabase
      .from("ig_accounts")
      .select("ig_user_id, page_access_token, page_id")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .is("page_id", null)
      .order("created_at", { ascending: false })
      .limit(1);

    const acc = Array.isArray(accRows) ? accRows[0] : null;
    if (!acc?.page_access_token) {
      return safeJson(res, 404, { error: "No active Instagram Login account found" });
    }

    // Find leads where ig_name is NULL or still equals the raw IGSID placeholder
    const { data: leads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, ig_psid, ig_name")
      .eq("client_id", req.coach.client_id)
      .or("ig_name.is.null,ig_name.eq.ig_psid")
      .order("created_at", { ascending: false })
      .limit(200);

    if (leadsErr) {
      return safeJson(res, 500, { error: leadsErr.message });
    }

    // Also catch leads where ig_name literally equals the ig_psid value (placeholder pattern)
    const { data: placeholderLeads } = await supabase
      .from("leads")
      .select("id, ig_psid, ig_name")
      .eq("client_id", req.coach.client_id)
      .not("ig_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);

    // Merge: any lead whose ig_name === ig_psid is still a placeholder
    const allLeads = [...(leads || [])];
    for (const l of (placeholderLeads || [])) {
      if (l.ig_name === l.ig_psid && !allLeads.find(x => x.id === l.id)) {
        allLeads.push(l);
      }
    }

    if (!allLeads.length) {
      return safeJson(res, 200, { updated: 0, skipped: 0, message: "All leads already have names" });
    }

    let updated = 0;
    let skipped = 0;
    const results = [];

    for (const lead of allLeads) {
      try {
        const name = await lookupIgName(acc.page_access_token, lead.ig_psid, {
          useInstagramApi: true,
          coachIgUserId: acc.ig_user_id,
        });

        if (name && name !== lead.ig_name) {
          await supabase.from("leads").update({ ig_name: name }).eq("id", lead.id);
          results.push({ id: lead.id, ig_psid: lead.ig_psid, name });
          updated++;
        } else {
          skipped++;
        }

        // Respect Instagram API rate limits — small delay between lookups
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.warn("backfill-names: lookup failed for", lead.ig_psid, e?.message || e);
        skipped++;
      }
    }

    console.log("backfill-names: done", { clientId: req.coach.client_id, updated, skipped });
    return safeJson(res, 200, { updated, skipped, results });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.get("/coach/api/instagram/status", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ig_accounts")
      .select("ig_user_id, ig_username, page_id, page_access_token, is_active")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return safeJson(res, 200, { connected: false });
    }

    // A row existing is not enough — the account is only connected if it has
    // actual Instagram data. A row with both fields null means the OAuth never
    // completed or the data was cleared.
    if (!data.ig_username && !data.ig_user_id) {
      return safeJson(res, 200, { connected: false });
    }

    // Auto-sync ig_username — routes to graph.instagram.com for Instagram Login
    // accounts (page_id is null) or graph.facebook.com for Facebook Login accounts.
    let currentUsername = data.ig_username || null;
    if (data.ig_user_id && data.page_access_token) {
      try {
        const useIgApi = !data.page_id;
        const meUrl = useIgApi
          ? `https://graph.instagram.com/v21.0/me?fields=username&access_token=${encodeURIComponent(data.page_access_token)}`
          : `https://graph.facebook.com/v21.0/${encodeURIComponent(data.ig_user_id)}?fields=username&access_token=${encodeURIComponent(data.page_access_token)}`;
        const meResp = await fetch(meUrl);
        if (meResp.ok) {
          const meData = await meResp.json();
          if (meData?.username && meData.username !== data.ig_username) {
            console.log(`ig_status: username changed from ${data.ig_username} to ${meData.username} for client ${req.coach.client_id} — updating DB`);
            await supabase
              .from("ig_accounts")
              .update({ ig_username: meData.username })
              .eq("ig_user_id", data.ig_user_id);
            currentUsername = meData.username;
          }
        }
      } catch {
        // Graph API call failed — use stored username, never fail the status check
      }
    }

    return safeJson(res, 200, {
      connected: true,
      username: currentUsername,
      ig_user_id: data.ig_user_id || null,
      page_id: data.page_id || null,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.get("/coach/api/instagram/profile", requireCoach, async (req, res) => {
  try {
    const { data: igAcc } = await supabase
      .from("ig_accounts")
      .select("ig_user_id, page_id, page_access_token")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!igAcc?.ig_user_id || !igAcc?.page_access_token) {
      return safeJson(res, 200, { connected: false });
    }

    const token = encodeURIComponent(igAcc.page_access_token);
    // Instagram Login accounts have page_id = null; use graph.instagram.com/me.
    // Facebook Login accounts have a page_id; use graph.facebook.com/{ig_user_id}.
    const useIgApi = !igAcc.page_id;
    const base = useIgApi
      ? "https://graph.instagram.com/v21.0/me"
      : `https://graph.facebook.com/v21.0/${encodeURIComponent(igAcc.ig_user_id)}`;

    const [profileResp, mediaResp] = await Promise.all([
      fetch(`${base}?fields=username,biography,followers_count,profile_picture_url&access_token=${token}`),
      fetch(`${base}/media?fields=id,media_type,thumbnail_url,media_url,permalink&limit=9&access_token=${token}`),
    ]);

    const [profileData, mediaData] = await Promise.all([
      profileResp.json(),
      mediaResp.json(),
    ]);

    return safeJson(res, 200, {
      connected: true,
      profile: {
        username:            profileData.username            || null,
        biography:           profileData.biography           || null,
        followers_count:     profileData.followers_count     ?? null,
        profile_picture_url: profileData.profile_picture_url || null,
      },
      media: (mediaData.data || []).slice(0, 9).map((m) => ({
        id:            m.id,
        type:          m.media_type,
        // Videos expose thumbnail_url; images expose media_url
        thumbnail_url: m.thumbnail_url || m.media_url || null,
        permalink:     m.permalink     || null,
      })),
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.get("/coach/api/comment-activity", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("comment_activity_log")
      .select("id, ig_username, trigger_type, keyword, status, created_at")
      .eq("coach_id", req.coach.client_id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { rows: data || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

async function getIgAccountByClientId(clientId) {
  const { data, error } = await supabase
    .from("ig_accounts")
    .select("*")
    .eq("client_id", clientId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data; // null if no active row
}

/**
 * ===========================
 * ADMIN AUTH
 * ===========================
 */

function signAdminToken() {
  if (!DASHBOARD_JWT_SECRET) return null;
  return jwt.sign({ role: "admin" }, DASHBOARD_JWT_SECRET, {
    expiresIn: "90d",
  });
}

function requireAdmin(req, res, next) {
  try {
    if (!DASHBOARD_JWT_SECRET) {
      return safeJson(res, 500, { error: "dashboard env not configured" });
    }

    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

    if (!token) return safeJson(res, 401, { error: "missing token" });

    const decoded = jwt.verify(token, DASHBOARD_JWT_SECRET);

    if (!decoded || decoded.role !== "admin") {
      return safeJson(res, 403, { error: "forbidden" });
    }

    req.admin = decoded;
    return next();
  } catch (e) {
    const msg =
      e?.name === "TokenExpiredError"
        ? "token expired"
        : e?.name === "JsonWebTokenError"
        ? `invalid token (${e.message})`
        : "invalid token";
    return safeJson(res, 401, { error: msg });
  }
}

/**
 * ===========================
 * ADMIN LOGIN
 * ===========================
 */

app.post("/admin/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return safeJson(res, 400, { error: "email and password required" });
    }

    if (!DASHBOARD_ADMIN_EMAIL || !DASHBOARD_ADMIN_PASSWORD) {
      return safeJson(res, 500, { error: "dashboard env not configured" });
    }

    const ok =
      String(email).trim().toLowerCase() ===
        String(DASHBOARD_ADMIN_EMAIL).trim().toLowerCase() &&
      String(password) === String(DASHBOARD_ADMIN_PASSWORD);

    if (!ok) return safeJson(res, 401, { error: "invalid credentials" });

    const token = signAdminToken();
    if (!token) {
      return safeJson(res, 500, {
        error: "Server auth not configured — DASHBOARD_JWT_SECRET environment variable is missing.",
      });
    }

    return safeJson(res, 200, { ok: true, token });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * ADMIN DASHBOARD STATS
 * ===========================
 */

// Manual DM queue flush — call this if messages get stuck
app.post("/admin/api/flush-dm-queue", requireAdmin, async (req, res) => {
  try {
    await processDmQueue();
    res.json({ ok: true, message: "DM queue flushed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/admin/api/stats", requireAdmin, async (req, res) => {
  try {
    const { count: clientsCount, error: cErr } = await supabase
      .from("clients")
      .select("*", { count: "exact", head: true });

    if (cErr) return safeJson(res, 500, cErr);

      const { count: leadsCount, error: lErr } = await supabase
      .from("leads")
      .select("*", { count: "exact", head: true });

    if (lErr) return safeJson(res, 500, lErr);

    const { count: msgsCount, error: mErr } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true });

    if (mErr) return safeJson(res, 500, mErr);

    return safeJson(res, 200, {
      ok: true,
      clients: clientsCount ?? 0,
      leads: leadsCount ?? 0,
      messages: msgsCount ?? 0,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * LIST CLIENTS
 * ===========================
 */

app.get("/admin/api/clients", requireAdmin, async (req, res) => {
  try {
    const { data: clients, error: err } = await supabase
      .from("clients")
      .select("*")
      .order("created_at", { ascending: false });

    if (err) return safeJson(res, 500, err);

    const clientIds = (clients || []).map((c) => c.id);

    const { data: configs, error: cfgErr } = await supabase
      .from("client_configs")
      .select("*")
      .in("client_id", clientIds);

    if (cfgErr) return safeJson(res, 500, cfgErr);

    const map = new Map();
    for (const cfg of configs || []) {
      map.set(cfg.client_id, cfg);
    }

    const merged = (clients || []).map((c) => ({
      ...c,
      config: map.get(c.id) || null,
    }));

    return safeJson(res, 200, { ok: true, clients: merged });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * CREATE CLIENT
 * ===========================
 */

app.post("/admin/api/clients/create", requireAdmin, async (req, res) => {
  try {
    const { name, email, timezone, setup_fee, monthly_retainer } = req.body || {};

    const clientName = String(name || "").trim();
    const coachEmail = String(email || "").trim().toLowerCase();
    const clientTimezone = String(timezone || "").trim() || "Europe/London";
    const setupFeePence = Number.isFinite(Number(setup_fee)) ? Math.round(Number(setup_fee)) : 0;
    const monthlyRetainerPence = Number.isFinite(Number(monthly_retainer)) ? Math.round(Number(monthly_retainer)) : 0;

    if (!clientName) {
      return safeJson(res, 400, { error: "name is required" });
    }

    if (!coachEmail) {
      return safeJson(res, 400, { error: "email is required" });
    }

    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .insert({
        name: clientName,
        timezone: clientTimezone,
        setup_fee: setupFeePence,
        monthly_retainer: monthlyRetainerPence,
      })
      .select()
      .single();

    if (clientErr) {
      return safeJson(res, 500, { error: String(clientErr.message || clientErr) });
    }

const { data: config, error: configErr } = await supabase
  .from("client_configs")
  .insert({
    client_id: client.id,
    stripe_subscription_status: null,
    system_prompt: "You are a helpful assistant that qualifies leads and books sales calls on behalf of this coach. Keep replies short, casual and conversational. Ask one question at a time to understand the lead's goals and situation before moving towards booking a call.",
    tone: "direct",
    style: "short, punchy",
    vocabulary: "casual UK coach",
    niche: "generic",
    offer_description: null,
    offer_price: null,
    what_you_do: null,
    what_they_get: null,
    how_it_works: null,
    who_its_for: null,
    main_result: null,
    best_fit_leads: null,
    not_a_fit: null,
    common_objections: null,
    closing_triggers: null,
    urgency_reason: null,
    trust_builders: null,
    faq: null,

story_reply_auto_dm_enabled: false,
story_reply_auto_dm_text: null,

comment_reply_auto_dm_enabled: false,
comment_reply_auto_dm_text: null,

keyword_auto_dm_enabled: false,
keyword_trigger_text: null,
keyword_auto_dm_text: null,
  })
  .select()
  .single();
    if (configErr) {
      return safeJson(res, 500, { error: String(configErr.message || configErr) });
    }

    return safeJson(res, 200, {
      ok: true,
      client,
      config,
      email: coachEmail,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * UPDATE CLIENT CONFIG
 * ===========================
 */

app.post("/admin/api/clients/:clientId/config", requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const patch = req.body || {};

    const allowed = {};

    if (typeof patch.system_prompt === "string")
      allowed.system_prompt = patch.system_prompt;

    if (typeof patch.offer_type === "string")
      allowed.offer_type = patch.offer_type;

    if (typeof patch.offer_url === "string" || patch.offer_url === null)
      allowed.offer_url = patch.offer_url;

    if (typeof patch.booking_url === "string" || patch.booking_url === null)
      allowed.booking_url = patch.booking_url;

    if (
      typeof patch.booking_url_alt === "string" ||
      patch.booking_url_alt === null
    )
      allowed.booking_url_alt = patch.booking_url_alt;

    if (typeof patch.followup_rules === "object")
      allowed.followup_rules = patch.followup_rules;

if (
  typeof patch.instagram_handle === "string" ||
  patch.instagram_handle === null
) {
  allowed.instagram_handle = patch.instagram_handle;
}
if (typeof patch.niche === "string" || patch.niche === null) {
  allowed.niche = patch.niche;
}

if (
  typeof patch.offer_description === "string" ||
  patch.offer_description === null
) {
  allowed.offer_description = patch.offer_description;
}
if (
  typeof patch.offer_price === "string" ||
  patch.offer_price === null
) {
  allowed.offer_price = patch.offer_price;
}
if (
  typeof patch.how_it_works === "string" ||
  patch.how_it_works === null
) {
  allowed.how_it_works = patch.how_it_works;
}
if (
  typeof patch.what_you_do === "string" ||
  patch.what_you_do === null
) {
  allowed.what_you_do = patch.what_you_do;
}

if (
  typeof patch.what_they_get === "string" ||
  patch.what_they_get === null
) {
  allowed.what_they_get = patch.what_they_get;
}

if (
  typeof patch.who_its_for === "string" ||
  patch.who_its_for === null
) {
  allowed.who_its_for = patch.who_its_for;
}
if (
  typeof patch.main_result === "string" ||
  patch.main_result === null
) {
  allowed.main_result = patch.main_result;
}
if (typeof patch.story_reply_auto_dm_enabled === "boolean") {
  allowed.story_reply_auto_dm_enabled = patch.story_reply_auto_dm_enabled;
}

if (
  typeof patch.story_reply_auto_dm_text === "string" ||
  patch.story_reply_auto_dm_text === null
) {
  allowed.story_reply_auto_dm_text = patch.story_reply_auto_dm_text;
}
if (typeof patch.comment_reply_auto_dm_enabled === "boolean") {
  allowed.comment_reply_auto_dm_enabled = patch.comment_reply_auto_dm_enabled;
}

if (
  typeof patch.comment_reply_auto_dm_text === "string" ||
  patch.comment_reply_auto_dm_text === null
) {
  allowed.comment_reply_auto_dm_text = patch.comment_reply_auto_dm_text;
}
if (typeof patch.keyword_auto_dm_enabled === "boolean") {
  allowed.keyword_auto_dm_enabled = patch.keyword_auto_dm_enabled;
}

if (
  typeof patch.keyword_trigger_text === "string" ||
  patch.keyword_trigger_text === null
) {
  allowed.keyword_trigger_text = patch.keyword_trigger_text;
}

if (
  typeof patch.keyword_auto_dm_text === "string" ||
  patch.keyword_auto_dm_text === null
) {
  allowed.keyword_auto_dm_text = patch.keyword_auto_dm_text;
}
// Feature 1 — comment keyword DM
if (typeof patch.comment_keyword_dm_enabled === "boolean") {
  allowed.comment_keyword_dm_enabled = patch.comment_keyword_dm_enabled;
}
if (typeof patch.comment_keyword_trigger === "string" || patch.comment_keyword_trigger === null) {
  allowed.comment_keyword_trigger = patch.comment_keyword_trigger;
}
if (typeof patch.comment_keyword_dm_text === "string" || patch.comment_keyword_dm_text === null) {
  allowed.comment_keyword_dm_text = patch.comment_keyword_dm_text;
}
if (typeof patch.comment_keyword_reply_enabled === "boolean") {
  allowed.comment_keyword_reply_enabled = patch.comment_keyword_reply_enabled;
}
if (typeof patch.comment_keyword_reply_text === "string" || patch.comment_keyword_reply_text === null) {
  allowed.comment_keyword_reply_text = patch.comment_keyword_reply_text;
}
// Feature 2 — contact collection
if (typeof patch.contact_collection_enabled === "boolean") {
  allowed.contact_collection_enabled = patch.contact_collection_enabled;
}
if (
  typeof patch.best_fit_leads === "string" ||
  patch.best_fit_leads === null
) {
  allowed.best_fit_leads = patch.best_fit_leads;
}

if (
  typeof patch.not_a_fit === "string" ||
  patch.not_a_fit === null
) {
  allowed.not_a_fit = patch.not_a_fit;
}

if (
  typeof patch.common_objections === "string" ||
  patch.common_objections === null
) {
  allowed.common_objections = patch.common_objections;
}

if (
  typeof patch.closing_triggers === "string" ||
  patch.closing_triggers === null
) {
  allowed.closing_triggers = patch.closing_triggers;
}

if (
  typeof patch.urgency_reason === "string" ||
  patch.urgency_reason === null
) {
  allowed.urgency_reason = patch.urgency_reason;
}

if (
  typeof patch.trust_builders === "string" ||
  patch.trust_builders === null
) {
  allowed.trust_builders = patch.trust_builders;
}

if (
  typeof patch.faq === "string" ||
  patch.faq === null
) {
  allowed.faq = patch.faq;
}

    if (typeof patch.bot_paused === "boolean")
      allowed.bot_paused = patch.bot_paused;

    if (
      typeof patch.bot_paused_reason === "string" ||
      patch.bot_paused_reason === null
    )
      allowed.bot_paused_reason = patch.bot_paused_reason;

    // Admin can adjust subscription status directly
    const validStripeStatuses = ["active", "trialing", "demo", "past_due", "canceled", "incomplete", null];
    if (patch.stripe_subscription_status !== undefined) {
      const s = patch.stripe_subscription_status === null ? null : String(patch.stripe_subscription_status);
      if (validStripeStatuses.includes(s)) allowed.stripe_subscription_status = s;
    }

    // Admin can set tone, style directly
    if (typeof patch.tone === "string" || patch.tone === null) allowed.tone = patch.tone;
    if (typeof patch.style === "string" || patch.style === null) allowed.style = patch.style;

    const { data: updated, error } = await supabase
      .from("client_configs")
      .update(allowed)
      .eq("client_id", clientId)
      .select()
      .single();

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, config: updated });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * ADMIN LEADS LIST
 * ===========================
 */

app.get("/admin/api/leads", requireAdmin, async (req, res) => {
  try {
    const clientId = req.query.client_id ? String(req.query.client_id) : null;

    let q = supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (clientId) q = q.eq("client_id", clientId);

    const { data: leads, error } = await q;

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, leads: leads || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * CREATE PAYMENT LINK
 * ===========================
 */

app.post("/admin/api/create-payment-link/:clientId", requireAdmin, async (req, res) => {
  try {
    assertStripeConfigured();
    const clientId = req.params.clientId;
    if (!clientId) return safeJson(res, 400, { error: "clientId required" });

    // Look up client pricing and coach email
    const { data: client } = await supabase.from("clients").select("setup_fee,monthly_retainer").eq("id", clientId).single();
    const { data: coachUser } = await supabase.from("coach_users").select("email").eq("client_id", clientId).maybeSingle();
    const coachEmail = coachUser?.email || null;

    // Create setup token BEFORE Stripe so it can go in the success URL
    const setupToken = crypto.randomBytes(24).toString("hex");
    const { error: tokenErr } = await supabase.from("payment_links").insert({
      token: setupToken,
      client_id: clientId,
      email: coachEmail,
    });
    if (tokenErr) return safeJson(res, 500, { error: String(tokenErr.message || tokenErr) });

    // Build line items — use client-specific pricing if set, else default prices
    const setupFeePence = Number(client?.setup_fee) || 0;
    const monthlyPence = Number(client?.monthly_retainer) || 0;

    let lineItems;
    if (monthlyPence > 0) {
      // Create dynamic Stripe prices for this client's custom pricing
      const monthlyPrice = await stripe.prices.create({
        currency: "gbp",
        unit_amount: monthlyPence,
        recurring: { interval: "month" },
        product_data: { name: "Monthly retainer" },
      });
      lineItems = [{ price: monthlyPrice.id, quantity: 1 }];
      if (setupFeePence > 0) {
        const setupPrice = await stripe.prices.create({
          currency: "gbp",
          unit_amount: setupFeePence,
          product_data: { name: "Setup fee" },
        });
        lineItems.push({ price: setupPrice.id, quantity: 1 });
      }
    } else {
      // Fall back to default plan prices
      lineItems = [{ price: STRIPE_PRICE_MONTHLY, quantity: 1 }];
      if (setupFeePence > 0) lineItems.push({ price: STRIPE_PRICE_SETUP, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: lineItems,
      customer_email: coachEmail || undefined,
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      metadata: { client_id: String(clientId), payment_token: setupToken },
      success_url: `${APP_PUBLIC_URL}/set-password?token=${setupToken}`,
      cancel_url: `${PAY_PUBLIC_URL}/cancel?cancelled=1`,
    });

    return safeJson(res, 200, { ok: true, url: session.url, token: setupToken });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * MARK CALL COMPLETE
 * ===========================
 */

app.post("/admin/api/leads/mark-call-complete", requireAdmin, async (req, res) => {
  try {
    const { client_id, ig_psid } = req.body || {};

    if (!client_id || !ig_psid) {
      return safeJson(res, 400, {
        error: "client_id and ig_psid required",
      });
    }

    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .update({ call_completed: true })
      .eq("client_id", client_id)
      .eq("ig_psid", ig_psid)
      .select()
      .single();

    if (leadErr) return safeJson(res, 500, leadErr);

    return safeJson(res, 200, { ok: true, lead });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});



/**
 * ===========================
 * ADMIN: LOGIN AS COACH
 * ===========================
 */

app.post("/admin/api/clients/:clientId/login-token", requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.clientId;
    if (!clientId) return safeJson(res, 400, { error: "clientId required" });

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id, name")
      .eq("id", clientId)
      .single();

    if (clientErr || !client) return safeJson(res, 404, { error: "client not found" });

    // Mint a short-lived coach token (admin impersonation — 4h only)
    if (!COACH_JWT_SECRET) return safeJson(res, 500, { error: "COACH_JWT_SECRET not configured" });
    const token = jwt.sign({ role: "coach", client_id: clientId, impersonated_by: "admin" }, COACH_JWT_SECRET, { expiresIn: "4h" });

    return safeJson(res, 200, { ok: true, token, client_name: client.name });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * ADMIN: SHOW CLIENT CREDENTIALS
 * ===========================
 */

const ADMIN_MASTER_PASSWORD = "Blughgfsdlsfhbdshfghdlfgdsu";

app.post("/admin/api/clients/:clientId/credentials", requireAdmin, async (req, res) => {
  try {
    const { master_password } = req.body || {};
    if (master_password !== ADMIN_MASTER_PASSWORD) {
      return safeJson(res, 403, { error: "incorrect master password" });
    }

    const clientId = req.params.clientId;

    const { data: user, error } = await supabase
      .from("coach_users")
      .select("email, created_at")
      .eq("client_id", clientId)
      .single();

    if (error || !user) return safeJson(res, 404, { error: "no coach user found for this client" });

    return safeJson(res, 200, { ok: true, email: user.email, note: "Password is hashed and cannot be recovered. Use reset-password flow to set a new one." });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * ADMIN: RESET CLIENT PASSWORD
 * ===========================
 */

app.post("/admin/api/clients/:clientId/reset-password", requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.clientId;

    const { data: user, error: lookupErr } = await supabase
      .from("coach_users")
      .select("id, email")
      .eq("client_id", clientId)
      .single();

    if (lookupErr || !user) {
      return safeJson(res, 404, { error: "No coach user found for this client" });
    }

    // Generate a readable random password: 3 words + 4 digits
    const words = ["Loop", "Coach", "Dash", "Link", "Bold", "Sync", "Core", "Flux", "Peak", "Rise"];
    const word1 = words[Math.floor(Math.random() * words.length)];
    const word2 = words[Math.floor(Math.random() * words.length)];
    const digits = String(Math.floor(1000 + Math.random() * 9000));
    const newPassword = `${word1}${word2}${digits}`;

    const hash = await bcrypt.hash(newPassword, 10);

    const { error: updateErr } = await supabase
      .from("coach_users")
      .update({ password_hash: hash })
      .eq("client_id", clientId);

    if (updateErr) {
      return safeJson(res, 500, { error: String(updateErr.message || updateErr) });
    }

    return safeJson(res, 200, { ok: true, email: user.email, new_password: newPassword });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Mute / unmute health alerts for a client ──────────────────────────────────
app.post("/admin/api/clients/:clientId/mute-alerts", requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { muted } = req.body || {};
    const { error } = await supabase
      .from("clients")
      .update({ alerts_muted: !!muted })
      .eq("id", clientId);
    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { ok: true, alerts_muted: !!muted });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Health issues log ─────────────────────────────────────────────────────────
app.get("/admin/api/health-issues", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("health_issues")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(200);
    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { issues: data || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/admin/api/health-issues/:issueId/resolve", requireAdmin, async (req, res) => {
  try {
    const { issueId } = req.params;
    const { resolved } = req.body || {};
    const patch = {
      resolved: !!resolved,
      resolved_at: resolved ? new Date().toISOString() : null,
    };
    const { data, error } = await supabase
      .from("health_issues")
      .update(patch)
      .eq("id", issueId)
      .select()
      .single();
    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { ok: true, issue: data });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.patch("/admin/api/health-issues/:issueId/notes", requireAdmin, async (req, res) => {
  try {
    const { issueId } = req.params;
    const { notes } = req.body || {};
    const { error } = await supabase
      .from("health_issues")
      .update({ notes: notes ?? null })
      .eq("id", issueId);
    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { ok: true });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Client offboarding ────────────────────────────────────────────────────────
app.post("/admin/api/clients/:clientId/offboard", requireAdmin, async (req, res) => {
  const { clientId } = req.params;
  const steps = [];

  try {
    // 1. Fetch client + config + coach user email
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id, name")
      .eq("id", clientId)
      .single();
    if (clientErr || !client) return safeJson(res, 404, { error: "Client not found" });

    const { data: cfg } = await supabase
      .from("client_configs")
      .select("stripe_subscription_id, stripe_customer_id")
      .eq("client_id", clientId)
      .maybeSingle();

    const { data: coachUser } = await supabase
      .from("coach_users")
      .select("email")
      .eq("client_id", clientId)
      .maybeSingle();

    const clientEmail = coachUser?.email || null;
    const clientName = client.name || clientId;

    // 2. Cancel Stripe subscription
    const subId = cfg?.stripe_subscription_id;
    if (subId && stripe) {
      try {
        await stripe.subscriptions.cancel(subId);
        steps.push("stripe_cancelled");
        log("offboard_stripe_cancelled", { clientId, subId });
      } catch (e) {
        // If already cancelled, treat as success
        if (e?.code === "resource_missing" || String(e?.message).includes("No such subscription")) {
          steps.push("stripe_already_cancelled");
        } else {
          console.warn("offboard: stripe cancel failed", e?.message);
          steps.push("stripe_cancel_failed");
        }
      }
    } else {
      steps.push("stripe_no_subscription");
    }

    // 3. Revoke Instagram token — delete the ig_accounts row(s) to deactivate
    try {
      const { data: igAccounts } = await supabase
        .from("ig_accounts")
        .select("id, page_access_token, ig_user_id, page_id")
        .eq("client_id", clientId)
        .eq("is_active", true);

      for (const acc of igAccounts || []) {
        // Instagram doesn't have a direct "revoke" API — deactivate by clearing token
        await supabase
          .from("ig_accounts")
          .update({ is_active: false, page_access_token: null })
          .eq("id", acc.id);
      }
      steps.push("ig_deactivated");
      log("offboard_ig_deactivated", { clientId, count: (igAccounts || []).length });
    } catch (e) {
      console.warn("offboard: ig deactivation failed", e?.message);
      steps.push("ig_deactivation_failed");
    }

    // 4. Update client row: deactivate + schedule deletion in 30 days
    const scheduledDeletion = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("clients")
      .update({
        is_active: false,
        offboarded_at: new Date().toISOString(),
        scheduled_deletion_at: scheduledDeletion,
      })
      .eq("id", clientId);

    // 5. Mark subscription as cancelled in client_configs
    await supabase
      .from("client_configs")
      .update({ stripe_subscription_status: "canceled" })
      .eq("client_id", clientId);

    steps.push("client_deactivated");
    log("offboard_complete", { clientId, clientName, steps });

    // 6. Send offboard email to coach
    if (resend && clientEmail) {
      try {
        const deletionDate = new Date(scheduledDeletion).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
        await resend.emails.send({
          from: ALERT_FROM,
          to: clientEmail,
          subject: "Your Looped account has been deactivated",
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
              <h2 style="margin:0 0 16px;font-size:22px;font-weight:900;">Your Looped account has been deactivated</h2>
              <p style="color:#333;font-size:15px;line-height:1.6;">Hi ${escHtml(clientName)},</p>
              <p style="color:#333;font-size:15px;line-height:1.6;">
                Your Looped account has been deactivated. Your Instagram connection has been removed and your subscription has been cancelled.
              </p>
              <p style="color:#333;font-size:15px;line-height:1.6;">
                Your account data (leads, messages, and settings) will be permanently deleted on <strong>${deletionDate}</strong>.
                If you believe this was done in error, please contact us before that date.
              </p>
              <p style="color:#555;font-size:13px;margin-top:24px;">The Looped team</p>
            </div>
          `,
        });
        steps.push("email_sent");
      } catch (e) {
        console.warn("offboard: email failed", e?.message);
        steps.push("email_failed");
      }
    }

    return safeJson(res, 200, { ok: true, steps, scheduled_deletion_at: scheduledDeletion });
  } catch (e) {
    console.error("offboard error:", e?.message || e);
    return safeJson(res, 500, { error: String(e?.message || e), steps });
  }
});

// ── Reactivate client (reverse offboard) ─────────────────────────────────────
app.post("/admin/api/clients/:clientId/reactivate", requireAdmin, async (req, res) => {
  const { clientId } = req.params;
  try {
    await supabase
      .from("clients")
      .update({ is_active: true, scheduled_deletion_at: null, offboarded_at: null })
      .eq("id", clientId);

    await supabase
      .from("ig_accounts")
      .update({ is_active: true })
      .eq("client_id", clientId);

    log("client_reactivated", { clientId });
    return safeJson(res, 200, { ok: true });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH AUTH + SUBSCRIPTION PROTECTION
 * ===========================
 */

function signCoachToken(client_id) {
  if (!COACH_JWT_SECRET) return null;
  return jwt.sign({ role: "coach", client_id }, COACH_JWT_SECRET, {
    expiresIn: "14d",
  });
}

async function requireCoach(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) return safeJson(res, 401, { error: "missing token" });

  // Verify JWT first — only JWT errors should return "invalid token"
  let decoded;
  try {
    decoded = jwt.verify(token, COACH_JWT_SECRET);
  } catch (e) {
    const msg =
      e?.name === "TokenExpiredError" ? "token expired" : "invalid token";
    return safeJson(res, 401, { error: msg });
  }

  if (!decoded || decoded.role !== "coach" || !decoded.client_id) {
    return safeJson(res, 403, { error: "forbidden" });
  }

  // Load config separately — DB errors should not surface as "invalid token"
  try {
    const cfg = await getClientConfig(decoded.client_id);
    const status = cfg?.stripe_subscription_status || null;

    // 🔒 subscription gate
    if (!isAllowedStripeStatus(status)) {
      return safeJson(res, 402, {
        error: "subscription_inactive",
        message: "Subscription inactive. Please complete payment to access the dashboard.",
        stripe_status: status,
      });
    }

    req.coach = decoded;
    req.coachConfig = cfg;
    return next();
  } catch (e) {
    console.error("[requireCoach] config load error:", e?.message);
    return safeJson(res, 500, { error: "Failed to load coach config" });
  }
}

/**
 * ===========================
 * COACH PASSWORD SETUP
 * ===========================
 */

app.post("/coach/api/set-password", async (req, res) => {
  try {
    const { token, email: bodyEmail, password } = req.body || {};

    if (!token || !password) {
      return safeJson(res, 400, { error: "token and password required" });
    }

    if (!bodyEmail || !String(bodyEmail).includes("@")) {
      return safeJson(res, 400, { error: "A valid email address is required." });
    }

    if (String(password).length < 8) {
      return safeJson(res, 400, {
        error: "password must be at least 8 characters",
      });
    }

    console.log("[set-password] token received:", token, "email:", bodyEmail);

    const { data: link, error: linkErr } = await supabase
      .from("payment_links")
      .select("*")
      .eq("token", token)
      .single();

    console.log("[set-password] link found:", link ? { client_id: link.client_id, email: link.email } : null, "err:", linkErr?.message || null);

    if (linkErr || !link) {
      return safeJson(res, 400, { error: "This setup link is invalid or has already been used." });
    }

    if (!link.client_id) {
      return safeJson(res, 400, {
        error: "Setup link is missing required information. Please contact support.",
      });
    }

    // Use email from request body (user enters it on the form — no webhook timing dependency)
    const coachEmail = String(bodyEmail).toLowerCase().trim();

    const password_hash = await bcrypt.hash(String(password), 10);

    const { data: existingUsers, error: existingUsersErr } = await supabase
      .from("coach_users")
      .select("*")
      .eq("email", String(coachEmail).toLowerCase())
      .limit(1);

    if (existingUsersErr) {
      return safeJson(res, 500, { error: String(existingUsersErr.message || existingUsersErr) });
    }

    if (existingUsers && existingUsers.length > 0) {
      const existingUser = existingUsers[0];

      const { error: updateErr } = await supabase
        .from("coach_users")
        .update({
          password_hash,
          client_id: link.client_id,
        })
        .eq("id", existingUser.id);

      if (updateErr) {
        return safeJson(res, 500, { error: String(updateErr.message || updateErr) });
      }
    } else {
      const { error: insertErr } = await supabase
        .from("coach_users")
        .insert({
          email: String(coachEmail).toLowerCase(),
          password_hash,
          client_id: link.client_id,
        });

      if (insertErr) {
        return safeJson(res, 500, { error: String(insertErr.message || insertErr) });
      }
    }

    // Mark token as used by deleting it so the link cannot be replayed
    await supabase.from("payment_links").delete().eq("token", token);

    return safeJson(res, 200, { ok: true });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH LOGIN
 * ===========================
 */

app.post("/coach/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return safeJson(res, 400, { error: "email and password required" });
    }

    const emailNorm = String(email).trim().toLowerCase();

    const { data: user, error } = await supabase
      .from("coach_users")
      .select("*")
      .eq("email", emailNorm)
      .single();

    if (error || !user) {
      return safeJson(res, 401, { error: "invalid credentials" });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return safeJson(res, 401, { error: "invalid credentials" });

    const cfg = await getClientConfig(user.client_id);
    const status = cfg?.stripe_subscription_status || null;

    // 🔒 block login unless paid
    if (!isAllowedStripeStatus(status)) {
      return safeJson(res, 402, {
        error: "subscription_inactive",
        message: "Subscription inactive. Please complete payment to access the dashboard.",
        stripe_status: status,
      });
    }

    const token = signCoachToken(user.client_id);
    const setupComplete = !!(cfg?.instagram_handle && String(cfg.instagram_handle).trim());
    return safeJson(res, 200, { ok: true, token, setup_complete: setupComplete });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * DEMO SELF-SIGNUP
 * ===========================
 */

app.post("/demo/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    const nameStr  = String(name  || "").trim();
    const emailStr = String(email || "").trim().toLowerCase();
    const passStr  = String(password || "");

    if (!nameStr)  return safeJson(res, 400, { error: "Name is required" });
    if (!emailStr) return safeJson(res, 400, { error: "Email is required" });
    if (!passStr || passStr.length < 8) {
      return safeJson(res, 400, { error: "Password must be at least 8 characters" });
    }

    // Block if email already registered
    const { data: existing } = await supabase
      .from("coach_users")
      .select("id")
      .eq("email", emailStr)
      .maybeSingle();

    if (existing) {
      return safeJson(res, 409, { error: "An account with this email already exists. Try logging in." });
    }

    // Create client row
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .insert({ name: nameStr, timezone: "Europe/London" })
      .select()
      .single();

    if (clientErr) {
      return safeJson(res, 500, { error: String(clientErr.message || clientErr) });
    }

    // Create client_config with stripe_subscription_status = 'demo'
    const { error: configErr } = await supabase
      .from("client_configs")
      .insert({
        client_id: client.id,
        stripe_subscription_status: "demo",
        system_prompt: "You are a helpful assistant that qualifies leads and books sales calls on behalf of this coach. Keep replies short, casual and conversational. Ask one question at a time to understand the lead's goals and situation before moving towards booking a call.",
        tone: "direct",
        style: "short, punchy",
        vocabulary: "casual UK coach",
        niche: "generic",
        offer_description: null,
        offer_price: null,
        what_you_do: null,
        what_they_get: null,
        how_it_works: null,
        who_its_for: null,
        main_result: null,
        best_fit_leads: null,
        not_a_fit: null,
        common_objections: null,
        closing_triggers: null,
        urgency_reason: null,
        trust_builders: null,
        faq: null,
        story_reply_auto_dm_enabled: false,
        story_reply_auto_dm_text: null,
        comment_reply_auto_dm_enabled: false,
        comment_reply_auto_dm_text: null,
        keyword_auto_dm_enabled: false,
        keyword_trigger_text: null,
        keyword_auto_dm_text: null,
      });

    if (configErr) {
      return safeJson(res, 500, { error: String(configErr.message || configErr) });
    }

    // Create coach_users row
    const password_hash = await bcrypt.hash(passStr, 10);
    const { error: userErr } = await supabase
      .from("coach_users")
      .insert({ email: emailStr, password_hash, client_id: client.id });

    if (userErr) {
      return safeJson(res, 500, { error: String(userErr.message || userErr) });
    }

    // Sign and return token — dashboard loads immediately, no payment step
    const token = signCoachToken(client.id);
    return safeJson(res, 200, { ok: true, token });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH INFO
 * ===========================
 */

app.get("/coach/api/me", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .eq("id", req.coach.client_id)
      .single();

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, client: data });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH CONFIG
 * ===========================
 */

app.get("/coach/api/config", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;
    const { data, error } = await supabase
      .from("client_configs")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle(); // maybeSingle: returns null (not error) when 0 rows

    console.log("[config load] client_id:", clientId, "found:", !!data, "error:", error?.message || null);

    if (error) return safeJson(res, 500, { error: error.message || String(error) });
    if (!data) return safeJson(res, 404, { error: "No config found for this account. Please contact support." });

    return safeJson(res, 200, { ok: true, config: data });
  } catch (e) {
    console.error("[config load] exception:", e?.message);
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});
app.get("/coach/api/prompt-usage", requireCoach, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("client_usage")
      .select("prompt_generations")
      .eq("client_id", req.coach.client_id)
      .eq("date", today)
      .single();

    // no row yet = 0 usage
    if (error && error.code !== "PGRST116") {
      return safeJson(res, 500, { error: String(error.message || error) });
    }

    const used = data?.prompt_generations || 0;
    const remaining = Math.max(0, MAX_PROMPTS_PER_DAY - used);

    return safeJson(res, 200, {
      ok: true,
      used,
      remaining,
      max: MAX_PROMPTS_PER_DAY,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/coach/api/config", requireCoach, async (req, res) => {
  try {
    const patch = req.body || {};
    console.log("[config save] received patch keys:", Object.keys(patch));
    console.log("[config save] comment_keyword_dm_enabled:", patch.comment_keyword_dm_enabled, "(type:", typeof patch.comment_keyword_dm_enabled, ")");
    console.log("[config save] comment_keyword_trigger:", patch.comment_keyword_trigger);
    console.log("[config save] comment_keyword_dm_text:", patch.comment_keyword_dm_text);
    const allowed = {};
if (typeof patch.example_messages === "string") {
  allowed.example_messages = patch.example_messages;
}
if (typeof patch.tone === "string" || patch.tone === null) {
  allowed.tone = patch.tone;
}

if (typeof patch.style === "string" || patch.style === null) {
  allowed.style = patch.style;
}

if (typeof patch.vocabulary === "string" || patch.vocabulary === null) {
  allowed.vocabulary = patch.vocabulary;
}
    if (typeof patch.system_prompt === "string") {
      allowed.system_prompt = patch.system_prompt;
    }
    if (typeof patch.booking_url === "string" || patch.booking_url === null) {
      allowed.booking_url = patch.booking_url;
    }
if (patch.story_reply_auto_dm_enabled !== undefined && patch.story_reply_auto_dm_enabled !== null) {
  allowed.story_reply_auto_dm_enabled = patch.story_reply_auto_dm_enabled === true || String(patch.story_reply_auto_dm_enabled) === "true";
}

if (
  typeof patch.story_reply_auto_dm_text === "string" ||
  patch.story_reply_auto_dm_text === null
) {
  allowed.story_reply_auto_dm_text = patch.story_reply_auto_dm_text;
}
if (patch.comment_reply_auto_dm_enabled !== undefined && patch.comment_reply_auto_dm_enabled !== null) {
  allowed.comment_reply_auto_dm_enabled = patch.comment_reply_auto_dm_enabled === true || String(patch.comment_reply_auto_dm_enabled) === "true";
}

if (
  typeof patch.comment_reply_auto_dm_text === "string" ||
  patch.comment_reply_auto_dm_text === null
) {
  allowed.comment_reply_auto_dm_text = patch.comment_reply_auto_dm_text;
}
if (patch.keyword_auto_dm_enabled !== undefined && patch.keyword_auto_dm_enabled !== null) {
  allowed.keyword_auto_dm_enabled = patch.keyword_auto_dm_enabled === true || String(patch.keyword_auto_dm_enabled) === "true";
}

if (
  typeof patch.keyword_trigger_text === "string" ||
  patch.keyword_trigger_text === null
) {
  allowed.keyword_trigger_text = patch.keyword_trigger_text;
}

if (
  typeof patch.keyword_auto_dm_text === "string" ||
  patch.keyword_auto_dm_text === null
) {
  allowed.keyword_auto_dm_text = patch.keyword_auto_dm_text;
}
// Feature 1 — comment keyword DM (accept both boolean and string "true"/"false")
if (patch.comment_keyword_dm_enabled !== undefined && patch.comment_keyword_dm_enabled !== null) {
  allowed.comment_keyword_dm_enabled = patch.comment_keyword_dm_enabled === true || String(patch.comment_keyword_dm_enabled) === "true";
}
if (typeof patch.comment_keyword_trigger === "string" || patch.comment_keyword_trigger === null) {
  allowed.comment_keyword_trigger = patch.comment_keyword_trigger;
}
if (typeof patch.comment_keyword_dm_text === "string" || patch.comment_keyword_dm_text === null) {
  allowed.comment_keyword_dm_text = patch.comment_keyword_dm_text;
}
if (patch.comment_keyword_reply_enabled !== undefined && patch.comment_keyword_reply_enabled !== null) {
  allowed.comment_keyword_reply_enabled = patch.comment_keyword_reply_enabled === true || String(patch.comment_keyword_reply_enabled) === "true";
}
if (typeof patch.comment_keyword_reply_text === "string" || patch.comment_keyword_reply_text === null) {
  allowed.comment_keyword_reply_text = patch.comment_keyword_reply_text;
}
// New follower auto-DM
if (typeof patch.new_follower_dm_text === "string" || patch.new_follower_dm_text === null) {
  allowed.new_follower_dm_text = patch.new_follower_dm_text;
}
// Feature 2 — contact collection
if (patch.contact_collection_enabled !== undefined && patch.contact_collection_enabled !== null) {
  allowed.contact_collection_enabled = patch.contact_collection_enabled === true || String(patch.contact_collection_enabled) === "true";
}
    if (
      typeof patch.booking_url_alt === "string" ||
      patch.booking_url_alt === null
    ) {
      allowed.booking_url_alt = patch.booking_url_alt;
    }
    if (
      typeof patch.instagram_handle === "string" ||
      patch.instagram_handle === null
    ) {
      allowed.instagram_handle = patch.instagram_handle;
    }
if (typeof patch.niche === "string" || patch.niche === null) {
  const n = String(patch.niche || "").trim().toLowerCase();
  allowed.niche = VALID_NICHES.includes(n) ? n : "generic";
  // If "other" niche, also store the custom text for reference
  if (n === "other" && patch.niche_other) {
    allowed.niche_other = String(patch.niche_other).trim().slice(0, 100) || null;
  }
}
    if (
      typeof patch.offer_description === "string" ||
      patch.offer_description === null
    ) {
      allowed.offer_description = patch.offer_description;
    }
if (
  typeof patch.offer_price === "string" ||
  patch.offer_price === null
) {
  allowed.offer_price = patch.offer_price;
}
if (
  typeof patch.how_it_works === "string" ||
  patch.how_it_works === null
) {
  allowed.how_it_works = patch.how_it_works;
}
if (
  typeof patch.what_you_do === "string" ||
  patch.what_you_do === null
) {
  allowed.what_you_do = patch.what_you_do;
}

if (
  typeof patch.what_they_get === "string" ||
  patch.what_they_get === null
) {
  allowed.what_they_get = patch.what_they_get;
}

if (
  typeof patch.who_its_for === "string" ||
  patch.who_its_for === null
) {
  allowed.who_its_for = patch.who_its_for;
}
if (
  typeof patch.main_result === "string" ||
  patch.main_result === null
) {
  allowed.main_result = patch.main_result;
}

if (
  typeof patch.best_fit_leads === "string" ||
  patch.best_fit_leads === null
) {
  allowed.best_fit_leads = patch.best_fit_leads;
}

if (
  typeof patch.not_a_fit === "string" ||
  patch.not_a_fit === null
) {
  allowed.not_a_fit = patch.not_a_fit;
}

if (
  typeof patch.common_objections === "string" ||
  patch.common_objections === null
) {
  allowed.common_objections = patch.common_objections;
}

if (
  typeof patch.closing_triggers === "string" ||
  patch.closing_triggers === null
) {
  allowed.closing_triggers = patch.closing_triggers;
}

if (
  typeof patch.urgency_reason === "string" ||
  patch.urgency_reason === null
) {
  allowed.urgency_reason = patch.urgency_reason;
}

if (
  typeof patch.trust_builders === "string" ||
  patch.trust_builders === null
) {
  allowed.trust_builders = patch.trust_builders;
}

if (
  typeof patch.faq === "string" ||
  patch.faq === null
) {
  allowed.faq = patch.faq;
}
if (typeof patch.calendly_api_key === "string" || patch.calendly_api_key === null) {
  allowed.calendly_api_key = patch.calendly_api_key || null;
}
// Feature 4: custom 24h follow-up message
if (typeof patch.followup_message === "string" || patch.followup_message === null) {
  allowed.followup_message = patch.followup_message || null;
}
// Structured voice training fields
for (const key of ["voice_price_reply", "voice_objection_reply", "voice_booking_push", "voice_quiet_lead", "voice_price_too_much", "voice_need_to_think", "voice_not_sure_works", "voice_no_time", "voice_ready_to_book", "voice_wants_link"]) {
  if (typeof patch[key] === "string" || patch[key] === null) {
    allowed[key] = patch[key] || null;
  }
}
// Feature 6: response delay (clamped server-side to 30s–180s)
if (patch.response_delay_ms != null) {
  const ms = Number(patch.response_delay_ms);
  if (!isNaN(ms) && ms >= 30000 && ms <= 180000) {
    allowed.response_delay_ms = ms;
  }
}
// Feature 2: products array
if (Array.isArray(patch.products)) {
  allowed.products = patch.products
    .filter((p) => p && typeof p.name === "string" && p.name.trim())
    .map((p) => ({
      id: String(p.id || crypto.randomUUID()),
      name: String(p.name).trim(),
      description: String(p.description || "").trim() || null,
      price: String(p.price || "").trim() || null,
      url: String(p.url || "").trim() || null,
      who_its_for: String(p.who_its_for || "").trim() || null,
    }));
}
// Booking items (unified booking links + products)
if (Array.isArray(patch.booking_items)) {
  allowed.booking_items = patch.booking_items
    .filter((item) => item && (item.name || item.url))
    .slice(0, 10)
    .map((item) => ({
      name: String(item.name || "").trim(),
      url: String(item.url || "").trim(),
      type: item.type === "product" ? "product" : "booking",
    }));
  // Keep booking_url in sync with first booking-type item
  const firstBooking = allowed.booking_items.find((i) => i.type === "booking");
  if (firstBooking?.url) allowed.booking_url = firstBooking.url;
}
    allowed.client_id = req.coach.client_id; // required for upsert conflict resolution

    console.log("[config save] client_id:", req.coach.client_id, "writing keys:", Object.keys(allowed));
    console.log("[config save] trigger values —", {
      story_reply_auto_dm_enabled: allowed.story_reply_auto_dm_enabled,
      story_reply_auto_dm_text: allowed.story_reply_auto_dm_text ? String(allowed.story_reply_auto_dm_text).slice(0, 80) : null,
      keyword_auto_dm_enabled: allowed.keyword_auto_dm_enabled,
      keyword_trigger_text: allowed.keyword_trigger_text,
      keyword_auto_dm_text: allowed.keyword_auto_dm_text ? String(allowed.keyword_auto_dm_text).slice(0, 80) : null,
    });

    const { data, error } = await supabase
      .from("client_configs")
      .upsert(allowed, { onConflict: "client_id" })
      .select()
      .single();

    if (error) {
      console.error("[config save] supabase upsert error:", error?.message, "code:", error?.code, "details:", error?.details);
      return safeJson(res, 500, { error: error?.message || String(error) });
    }

    console.log("[config save] success for client_id:", req.coach.client_id, "niche:", data?.niche, "instagram_handle:", data?.instagram_handle);
    return safeJson(res, 200, { ok: true, config: data });
  } catch (e) {
    console.error("[config save] caught exception:", e?.message);
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * GLOBAL BOT PAUSE
 * ===========================
 */

app.post("/coach/api/bot-paused", requireCoach, async (req, res) => {
  try {
    const { enabled, reason } = req.body || {};

    const updated = await setClientBotPaused({
      clientId: req.coach.client_id,
      enabled: !!enabled,
      reason: reason || (enabled ? "Paused by coach" : "Resumed by coach"),
      actor: "coach",
    });

    return safeJson(res, 200, { ok: true, config: updated });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ─── Activity stream (SSE) ────────────────────────────────────────────────────
// EventSource can't set headers, so we accept the JWT via ?token= query param.
app.get("/coach/api/activity-stream", async (req, res) => {
  const token = req.query.token || "";
  if (!token) return res.status(401).end();

  let coach;
  try {
    coach = jwt.verify(token, COACH_JWT_SECRET);
  } catch {
    return res.status(401).end();
  }

  const clientId = coach.client_id;
  if (!clientId) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Render/nginx buffering

  // Must flush headers before writing — required for SSE
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: "connected", ts: new Date().toISOString() })}\n\n`);

  if (!activityStreamClients.has(clientId)) {
    activityStreamClients.set(clientId, new Set());
  }
  activityStreamClients.get(clientId).add(res);
  console.log(`activity-stream: coach ${clientId} connected (total: ${activityStreamClients.get(clientId).size})`);

  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch { clearInterval(hb); }
  }, 20000);

  req.on("close", () => {
    clearInterval(hb);
    activityStreamClients.get(clientId)?.delete(res);
    console.log(`activity-stream: coach ${clientId} disconnected`);
  });
});

app.get("/coach/api/bot-paused", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("client_configs")
      .select("client_id,bot_paused,bot_paused_reason,bot_paused_by,bot_paused_at")
      .eq("client_id", req.coach.client_id)
      .single();

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, status: data });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * MANUAL TAKEOVER (COACH)
 * ===========================
 */

app.post("/coach/api/leads/:leadId/manual-override", requireCoach, async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const { enabled, reason } = req.body || {};

    const updated = await setLeadManualOverride({
      leadId,
      clientId: req.coach.client_id,
      enabled: !!enabled,
      reason,
      actor: "coach",
    });

    return safeJson(res, 200, { ok: true, lead: updated });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// Resume bot for a lead: clears manual_override then immediately generates + sends a reply
// based on the lead's last inbound message, so the coach doesn't need to wait.
app.post("/coach/api/leads/:leadId/resume", requireCoach, async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const clientId = req.coach.client_id;

    // 1. Fetch lead
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .eq("client_id", clientId)
      .single();
    if (leadErr || !lead) return safeJson(res, 404, { error: "Lead not found" });

    // 2. Clear the pause
    await setLeadManualOverride({ leadId, clientId, enabled: false, reason: "Reset by coach", actor: "coach" });

    // 3. Respond early — the reply generation runs async
    safeJson(res, 200, { ok: true });

    // 4. Get last inbound message text
    const { data: msgs } = await supabase
      .from("messages")
      .select("text, direction, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(20);

    const lastInbound = (msgs || []).find((m) => m.direction === "in" && m.text);
    if (!lastInbound?.text) return; // Nothing to reply to

    const userText = lastInbound.text;

    // 5. Build everything needed for generateAiReply
    const cfg = await getClientConfig(clientId);
    const niche = getEffectiveNiche(cfg);
    const igAccount = await getIgAccountByClientId(clientId).catch(() => null);
    if (!igAccount?.page_access_token) return;

    const historyMessages = await getLeadMessageHistory(leadId, 30).catch(() => []);
    const { data: memRow } = await supabase.from("lead_memory").select("*").eq("lead_id", leadId).maybeSingle();
    const leadMemory = memRow || null;

    const userIntent = detectUserIntent(userText);
    const bookingUrl = cfg?.booking_url || "";
    const conversationState = deriveConversationState({ lead, leadMemory, userIntent });
    let turnStrategy = decideTurnStrategyFromIntent({ userIntent, conversationState, lead, leadMemory, text: userText, bookingUrl });
    turnStrategy = preventRepeatedReplyType(turnStrategy, leadMemory);

    const thinkAboutIt = detectThinkAboutIt(userText);
    const asksPrice = detectPriceQuestion(userText);
    const highIntent = detectHighIntent(userText);

    const aiResult = await generateAiReply({
      cfg, lead, historyMessages, leadMemory, turnStrategy,
      postCallMode: !!lead?.call_completed,
      asksPrice, highIntent, bookingUrl, thinkAboutIt, userText,
    });

    if (!aiResult?.reply) return;

    const replyText = sanitizeReply(aiResult.reply);
    if (!replyText) return;

    const { sendResp } = await sendInstagramTextMessage({
      accessToken: igAccount.page_access_token,
      recipientId: lead.ig_psid,
      text: replyText,
      useInstagramApi: !igAccount.page_id,
    });

    if (!sendResp.ok) return;

    await supabase.from("messages").insert({
      lead_id: leadId,
      client_id: clientId,
      direction: "out",
      text: replyText,
      created_at: new Date().toISOString(),
    });

    await updateLeadTracking(leadId, {
      last_outbound_at: new Date().toISOString(),
      last_outbound_text: replyText,
    }).catch(() => {});

    const leadName = lead.ig_name || `Lead ${String(lead.ig_psid || "").slice(-6)}`;
    emitActivityEvent(clientId, {
      type: "reply_sent",
      leadName,
      igPsid: lead.ig_psid,
      preview: replyText.slice(0, 120),
    });
    log("resume_reply_sent", { leadId, clientId });
  } catch (e) {
    console.error("resume endpoint error:", e?.message || e);
  }
});

app.get("/coach/api/leads/:leadId/messages", requireCoach, async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const clientId = req.coach.client_id;

    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("id, ig_psid")
      .eq("id", leadId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (leadErr) return safeJson(res, 500, { error: leadErr.message });
    if (!lead) return safeJson(res, 404, { error: "Lead not found" });

    const { data: messages, error: msgErr } = await supabase
      .from("messages")
      .select("id, direction, text, created_at, message_type, story_id, story_url, story_media_url")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (msgErr) return safeJson(res, 500, { error: msgErr.message });

    return safeJson(res, 200, { ok: true, messages: messages || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// On-demand story media fetch — called by the inbox when story_media_url is null.
// Uses the coach's current access token from ig_accounts (fresher than the one
// available at webhook time). Updates the message row if media is found.
app.get("/coach/api/messages/:messageId/story-media", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;
    const messageId = req.params.messageId;

    // Verify message belongs to this client and is a story reply
    const { data: msg, error: msgErr } = await supabase
      .from("messages")
      .select("id, story_id, story_url, story_media_url, message_type, lead_id")
      .eq("id", messageId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (msgErr) return safeJson(res, 500, { error: msgErr.message });
    if (!msg) return safeJson(res, 404, { error: "Message not found" });
    if (msg.message_type !== "story_reply") return safeJson(res, 400, { error: "Not a story reply" });

    // If already resolved, return immediately
    if (msg.story_media_url) {
      return safeJson(res, 200, { ok: true, story_media_url: msg.story_media_url, story_url: msg.story_url, source: "cached" });
    }

    if (!msg.story_id) {
      return safeJson(res, 200, { ok: true, story_media_url: null, story_url: msg.story_url, source: "no_story_id" });
    }

    // Get coach's current access token
    const { data: igRows } = await supabase
      .from("ig_accounts")
      .select("page_access_token, fb_page_token")
      .eq("client_id", clientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    const igAccount = Array.isArray(igRows) ? igRows[0] : null;
    const accessToken = igAccount?.page_access_token || null;

    if (!accessToken) {
      return safeJson(res, 200, { ok: true, story_media_url: null, story_url: msg.story_url, source: "no_token" });
    }

    // Try graph.instagram.com
    let storyMediaUrl = null;
    let source = "not_found";

    const igApiUrl = `https://graph.instagram.com/v21.0/${encodeURIComponent(msg.story_id)}?fields=media_url,thumbnail_url,media_type&access_token=${encodeURIComponent(accessToken)}`;
    console.log("story-media endpoint: calling graph.instagram.com", { messageId, storyId: msg.story_id });
    const igResp = await fetch(igApiUrl);
    const igData = await igResp.json().catch(() => ({}));
    console.log("story-media endpoint: graph.instagram.com response", { messageId, storyId: msg.story_id, status: igResp.status, data: igData });

    storyMediaUrl = igData?.media_url || igData?.thumbnail_url || null;
    if (storyMediaUrl) source = "graph.instagram.com";

    // Fallback: graph.facebook.com
    if (!storyMediaUrl) {
      const fbApiUrl = `https://graph.facebook.com/v23.0/${encodeURIComponent(msg.story_id)}?fields=media_url,thumbnail_url,media_type&access_token=${encodeURIComponent(accessToken)}`;
      console.log("story-media endpoint: calling graph.facebook.com fallback", { messageId, storyId: msg.story_id });
      const fbResp = await fetch(fbApiUrl);
      const fbData = await fbResp.json().catch(() => ({}));
      console.log("story-media endpoint: graph.facebook.com response", { messageId, storyId: msg.story_id, status: fbResp.status, data: fbData });

      storyMediaUrl = fbData?.media_url || fbData?.thumbnail_url || null;
      if (storyMediaUrl) source = "graph.facebook.com";
    }

    // Persist if found so future loads use cached value
    if (storyMediaUrl) {
      await supabase.from("messages").update({ story_media_url: storyMediaUrl }).eq("id", messageId);
    }

    return safeJson(res, 200, { ok: true, story_media_url: storyMediaUrl, story_url: msg.story_url, source });
  } catch (e) {
    console.error("story-media endpoint error", e?.message || e);
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/coach/api/leads/:leadId/reply", requireCoach, async (req, res) => {
  try {
    const leadId = req.params.leadId;
    const clientId = req.coach.client_id;
    const text = String(req.body?.text || "").trim();

    if (!text) return safeJson(res, 400, { error: "text is required" });

    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("id, ig_psid")
      .eq("id", leadId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (leadErr) return safeJson(res, 500, { error: leadErr.message });
    if (!lead) return safeJson(res, 404, { error: "Lead not found" });
    if (!lead.ig_psid) return safeJson(res, 400, { error: "Lead has no Instagram IGSID" });

    const { data: igAccount, error: igErr } = await supabase
      .from("ig_accounts")
      .select("page_access_token, page_id")
      .eq("client_id", clientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (igErr) return safeJson(res, 500, { error: igErr.message });
    if (!igAccount?.page_access_token) {
      return safeJson(res, 400, { error: "No connected Instagram account" });
    }

    const { sendResp, sendData } = await sendInstagramTextMessage({
      accessToken: igAccount.page_access_token,
      recipientId: lead.ig_psid,
      text,
      useInstagramApi: !igAccount.page_id,
    });

    if (!sendResp.ok) {
      return safeJson(res, 502, { error: `Instagram API error: ${JSON.stringify(sendData)}` });
    }

    const { error: insertErr } = await supabase
      .from("messages")
      .insert({
        lead_id: leadId,
        client_id: clientId,
        direction: "out",
        text,
        created_at: new Date().toISOString(),
      });

    if (insertErr) {
      console.error("inbox reply insert error:", insertErr);
    }

    // Pause bot for this lead since coach is taking over
    await setLeadManualOverride({
      leadId,
      clientId,
      enabled: true,
      reason: "Coach replied from inbox",
      actor: "coach",
    }).catch(() => {});

    return safeJson(res, 200, { ok: true });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.get("/coach/api/leads", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;
    console.log("[leads] fetching for client_id:", clientId);
    const { data: leads, error } = await supabase
      .from("leads")
      .select(
        "id,created_at,ig_psid,ig_name,stage,booking_sent,call_completed,manual_override,manual_override_reason,manual_override_by,manual_override_at,last_inbound_at,last_outbound_at,email,phone,followup_sent"
      )
      .eq("client_id", clientId)
      .order("last_inbound_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("[leads] supabase error:", error?.message, "code:", error?.code);
      return safeJson(res, 500, { error: error?.message || String(error) });
    }

    console.log("[leads] returned", (leads || []).length, "rows for client_id:", clientId);
    return safeJson(res, 200, { ok: true, leads: leads || [] });
  } catch (e) {
    console.error("[leads] exception:", e?.message);
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Debug: probe messages table schema and test insert ───────────────────
app.get("/coach/api/debug/messages", requireCoach, async (req, res) => {
  // Safe serialiser — avoids circular-reference crashes from Supabase error objects
  function flatErr(e) {
    if (!e) return null;
    if (typeof e === "string") return e;
    return {
      message: e.message ?? null,
      details: e.details ?? null,
      hint: e.hint ?? null,
      code: e.code ?? null,
    };
  }

  const out = { client_id: req.coach.client_id };

  // 1. Fetch one row to see what columns actually exist
  try {
    const { data, error } = await supabase.from("messages").select("*").limit(1);
    out.sample_row = data?.[0] ? Object.keys(data[0]) : [];
    out.sample_row_error = flatErr(error);
  } catch (e) { out.sample_row_error = String(e.message); }

  // 2. Total row count (no client_id filter — avoids failure if column missing)
  try {
    const { count, error } = await supabase
      .from("messages").select("*", { count: "exact", head: true });
    out.total_rows = count;
    out.total_rows_error = flatErr(error);
  } catch (e) { out.total_rows_error = String(e.message); }

  // 3. Get a real lead for the test insert
  try {
    const { data: lead, error } = await supabase
      .from("leads").select("id, client_id").eq("client_id", req.coach.client_id)
      .limit(1).maybeSingle();
    out.test_lead = lead ? { id: lead.id, client_id: lead.client_id } : null;
    out.test_lead_error = flatErr(error);

    // 4. Attempt the exact same insert the webhook does
    if (lead) {
      const { data: inserted, error: insertErr } = await supabase
        .from("messages")
        .insert({
          lead_id: lead.id,
          client_id: lead.client_id,
          direction: "in",
          text: "[debug test — safe to delete]",
          created_at: new Date().toISOString(),
        })
        .select();

      out.test_insert_ok = !insertErr;
      out.test_insert_error = flatErr(insertErr);
      out.test_insert_row = inserted?.[0] ?? null;

      // Clean up immediately
      if (inserted?.[0]?.id) {
        await supabase.from("messages").delete().eq("id", inserted[0].id).catch(() => {});
      }
    }
  } catch (e) { out.test_lead_error = String(e.message); }

  return safeJson(res, 200, out);
});

// ── Debug: return what client_id the JWT has vs ig_accounts ──────────────
app.get("/coach/api/instagram/debug", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;

    const { data: igRows } = await supabase
      .from("ig_accounts")
      .select("id, client_id, ig_user_id, page_id, ig_username, is_active, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: coachRow } = await supabase
      .from("coach_users")
      .select("id, email, client_id")
      .eq("client_id", clientId)
      .maybeSingle();

    return safeJson(res, 200, {
      jwt_client_id: clientId,
      coach_user: coachRow || null,
      ig_accounts: igRows || [],
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Backfill ig_name for leads where it is null ───────────────────────────
app.post("/coach/api/leads/refresh-names", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;

    // Get page_access_token for this coach
    const { data: igAcc } = await supabase
      .from("ig_accounts")
      .select("page_access_token, ig_username")
      .eq("client_id", clientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!igAcc?.page_access_token) {
      return safeJson(res, 400, {
        error: "No active Instagram connection found. Connect Instagram first.",
      });
    }

    // Find leads with no ig_name
    const { data: leads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, ig_psid")
      .eq("client_id", clientId)
      .is("ig_name", null)
      .not("ig_psid", "is", null)
      .limit(200);

    if (leadsErr) return safeJson(res, 500, { error: leadsErr.message });
    if (!leads || !leads.length) {
      return safeJson(res, 200, { ok: true, updated: 0, message: "All leads already have names." });
    }

    let updated = 0;
    let failed = 0;

    for (const lead of leads) {
      const name = await lookupIgName(igAcc.page_access_token, lead.ig_psid);
      if (name) {
        const { error: upErr } = await supabase
          .from("leads")
          .update({ ig_name: name })
          .eq("id", lead.id);
        if (!upErr) updated++;
        else failed++;
      } else {
        failed++;
      }
      // Respect Instagram API rate limits
      await new Promise((r) => setTimeout(r, 120));
    }

    return safeJson(res, 200, {
      ok: true,
      updated,
      failed,
      total: leads.length,
      message: `Updated ${updated} of ${leads.length} leads.`,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH PROMPT GENERATOR
 * ===========================
 */
app.post("/coach/api/generate-prompt", requireCoach, async (req, res) => {
// 🔒 DAILY LIMIT PROTECTION (PUT HERE ONLY)
const today = new Date().toISOString().slice(0, 10);

const { data: usageRow } = await supabase
  .from("client_usage")
  .select("*")
  .eq("client_id", req.coach.client_id)
  .eq("date", today)
  .single();

const used = usageRow?.prompt_generations || 0;

if (used >= MAX_PROMPTS_PER_DAY) {
  return safeJson(res, 429, {
    error: "daily_limit_reached",
    message: "You’ve reached your daily limit for generating prompts.",
    remaining: 0,
  });
}
  try {
const {
  instagram_handle,
  example_messages,
  offer_description,
  offer_price,
  what_you_do,
  what_they_get,
  how_it_works,
  who_its_for,
  main_result,
  best_fit_leads,
  not_a_fit,
  common_objections,
  closing_triggers,
  urgency_reason,
  trust_builders,
  faq,
  niche,
} = req.body || {};

const handleRaw = String(instagram_handle || "").trim();

    if (!handleRaw) {
      return safeJson(res, 400, { error: "instagram_handle is required" });
    }

    const handle = handleRaw.startsWith("@") ? handleRaw.slice(1) : handleRaw;
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) {
      return safeJson(res, 400, { error: "invalid instagram handle format" });
    }

const { data: cfg, error: cfgError } = await supabase
  .from("client_configs")
  .select("*")
  .eq("client_id", req.coach.client_id)
  .single();

if (cfgError) {
  return safeJson(res, 500, {
    error: String(cfgError.message || cfgError),
  });
}
const exampleMessages =
  String(example_messages || cfg?.example_messages || "").trim();
const offerDescription =
  String(offer_description || cfg?.offer_description || "").trim();
const offerPrice =
  String(offer_price || cfg?.offer_price || "").trim();
const whatYouDo =
  String(what_you_do || cfg?.what_you_do || "").trim();
const whatTheyGet =
  String(what_they_get || cfg?.what_they_get || "").trim();
const howItWorks =
  String(how_it_works || cfg?.how_it_works || "").trim();
const whoItsFor =
  String(who_its_for || cfg?.who_its_for || "").trim();
const mainResult =
  String(main_result || cfg?.main_result || "").trim();
const bestFitLeads =
  String(best_fit_leads || cfg?.best_fit_leads || "").trim();
const notAFit =
  String(not_a_fit || cfg?.not_a_fit || "").trim();
const commonObjections =
  String(common_objections || cfg?.common_objections || "").trim();
const closingTriggers =
  String(closing_triggers || cfg?.closing_triggers || "").trim();
const urgencyReason =
  String(urgency_reason || cfg?.urgency_reason || "").trim();
const trustBuilders =
  String(trust_builders || cfg?.trust_builders || "").trim();
const faqText =
  String(faq || cfg?.faq || "").trim();
const effectiveNiche = getEffectiveNiche({
  niche: niche || cfg?.niche || "generic",
});
if (!openai) {
  const stub = [
    "You are the coach's Instagram DM assistant.",
    "Tone: friendly, confident, concise, UK vibe.",
    "Write 1-2 short sentences max and end with ONE clear question.",
    "Never mention AI.",
    "No emojis by default. No em dashes or double hyphens.",
    "Avoid repeating yourself; keep the conversation moving forward.",
    "If asked about price: ask goal + current situation, say you'll confirm exact options.",
    `Coach context: Instagram handle is @${handle}. Mirror their style (short, punchy, motivating).`,
  ].join("\n");

  await supabase
    .from("client_configs")
    .update({
      system_prompt: stub,
      tone: "direct",
      style: "short, punchy",
      vocabulary: "casual",
      instagram_handle: handle,
      niche: effectiveNiche,
    })
    .eq("client_id", req.coach.client_id);

  await supabase.from("client_usage").upsert({
    client_id: req.coach.client_id,
    date: today,
    prompt_generations: used + 1,
  });

  return safeJson(res, 200, {
    ok: true,
    system_prompt: stub,
    tone: "direct",
    style: "short, punchy",
    vocabulary: "casual",
    used_ai: false,
    remaining: MAX_PROMPTS_PER_DAY - (used + 1),
  });
}

    const messages = [
      {
        role: "system",
        content: `
You create high-converting Instagram DM assistant prompts for coaches.

Return ONLY valid JSON in this exact format:
{
  "system_prompt": "...",
  "tone": "...",
  "style": "...",
  "vocabulary": "..."
}

The prompt must:
- sound human, not AI
- prioritise casual, natural conversation
- avoid anything corporate or robotic
- be concise and practical
`,
      },
{
  role: "user",
content: `
Coach Instagram handle: @${handle}
NICHE: ${effectiveNiche}

Create a system prompt for their DM assistant.

STYLE REQUIREMENTS:
- Replies must feel like real texting
- Slightly imperfect grammar is allowed
- Keep messages short (1 sentence, max 2)
- No over-explaining
- No corporate tone
- No assistant-style language

CONVERSATION RULES:
- Ask 1 simple question at a time
- Never ask multiple questions
- Don’t repeat yourself
- Be slightly blunt when needed
- Avoid sounding fake, scripted, or pushy in a cringe way
- But still sound commercially aware and willing to lead the conversation

STRICT RULES:
- No emojis unless natural
- No em dashes or long punctuation
- Never mention AI
- Never sound like support or a chatbot
- Never write long structured messages

GOAL:
Make the conversation feel like a normal Instagram DM with someone sharp who knows how to lead a sale naturally.

IMPORTANT SALES BEHAVIOUR:
- If the lead is warm, interested, asks price, asks how it works, or asks how to start, the prompt should bias toward moving them closer to booking
- The assistant should not stay stuck in endless conversation mode
- The assistant should qualify briefly, then guide decisively

IMPORTANT NICHE RULE:
- niche is "${effectiveNiche}" (${getNicheLabel(effectiveNiche)})
- use terminology and conversational framing natural for that niche: fitness = training/results/body; money = clients/revenue/offer; mindset = beliefs/patterns/clarity; nutrition = food/diet/habits; relationship = communication/connection/patterns; career = direction/opportunities/growth; life = goals/habits/accountability; sales = pipeline/conversion/close; marketing = messaging/content/reach; leadership = team/culture/decisions
- do not mix niches, do not sound generic if niche context is available

WHAT THE COACH DOES:
${whatYouDo || "(not provided)"}

WHAT THE LEAD GETS:
${whatTheyGet || "(not provided)"}

FULL OFFER DESCRIPTION:
${offerDescription || "(not provided)"}

PRICE:
${offerPrice || "(not provided)"}

WHO IT'S FOR:
${whoItsFor || "(not provided)"}

HOW IT WORKS:
${howItWorks || "(not provided)"}

MAIN RESULT / PROMISED OUTCOME:
${mainResult || "(not provided)"}

BEST FIT LEADS:
${bestFitLeads || "(not provided)"}

NOT A FIT:
${notAFit || "(not provided)"}

COMMON OBJECTIONS:
${commonObjections || "(not provided)"}

CLOSING TRIGGERS:
${closingTriggers || "(not provided)"}

URGENCY / WHY NOW:
${urgencyReason || "(not provided)"}

TRUST BUILDERS:
${trustBuilders || "(not provided)"}

FAQ:
${faqText || "(not provided)"}

REAL MESSAGE EXAMPLES FROM THE COACH:
${exampleMessages || "(none provided)"}

IMPORTANT:
If real examples are provided, base the personality primarily on those examples.
Match their bluntness, pacing, wording, sentence length, and tone.
Do not copy lines word-for-word.
Use the handle only as weak context. Use the examples as the main signal.

Existing prompt:
${cfg?.system_prompt || "(none)"}
`,
},
    ];

const resp = await openai.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  messages,
  temperature: 0.5,
  max_tokens: 350,
  response_format: { type: "json_object" },
});

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return safeJson(res, 500, { error: "failed to generate prompt" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return safeJson(res, 500, {
        error: "failed to parse AI response",
        raw: text,
      });
    }

    const generatedPrompt = parsed.system_prompt || "";
    const generatedTone = parsed.tone || "direct";
    const generatedStyle = parsed.style || "short, punchy";
    const generatedVocab = parsed.vocabulary || "casual";

const { error: updatePersonalityError } = await supabase
  .from("client_configs")
  .update({
    system_prompt: generatedPrompt,
    tone: generatedTone,
    style: generatedStyle,
    vocabulary: generatedVocab,
    instagram_handle: handle,
    niche: effectiveNiche,
  })
      .eq("client_id", req.coach.client_id);

    if (updatePersonalityError) {
      return safeJson(res, 500, {
        error: `failed to save generated personality: ${updatePersonalityError.message || updatePersonalityError}`,
      });
    }

// ✅ increment usage AFTER successful AI generation
await supabase.from("client_usage").upsert({
  client_id: req.coach.client_id,
  date: today,
  prompt_generations: used + 1,
});

return safeJson(res, 200, {
  ok: true,
  system_prompt: generatedPrompt,
  tone: generatedTone,
  style: generatedStyle,
  vocabulary: generatedVocab,
  used_ai: true,
  remaining: MAX_PROMPTS_PER_DAY - (used + 1),
});
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * BOT PREVIEW CONVERSATION
 * ===========================
 */

app.post("/coach/api/preview-conversation", requireCoach, async (req, res) => {
  try {
    const { data: cfg, error: cfgErr } = await supabase
      .from("client_configs")
      .select("*")
      .eq("client_id", req.coach.client_id)
      .single();

    if (cfgErr) return safeJson(res, 500, { error: String(cfgErr.message || cfgErr) });

    const niche = getEffectiveNiche({ niche: cfg?.niche || "generic" });
    const bookingUrl = String(cfg?.booking_url || "https://calendly.com/yourcoach/discovery").trim();
    const offerPrice = String(cfg?.offer_price || "").trim();
    const systemPrompt = String(cfg?.system_prompt || "").trim();
    const tone = String(cfg?.tone || "direct").trim();
    const style = String(cfg?.style || "short, punchy").trim();
    const whatYouDo = String(cfg?.what_you_do || "").trim();
    const whatTheyGet = String(cfg?.what_they_get || "").trim();
    const exampleMessages = String(cfg?.example_messages || "").trim();

    const offerContext = [
      whatYouDo && `What the coach does: ${whatYouDo}`,
      whatTheyGet && `What clients get: ${whatTheyGet}`,
      offerPrice && `Offer price: ${offerPrice}`,
      bookingUrl && `Booking link: ${bookingUrl}`,
    ].filter(Boolean).join("\n");

    const promptContent = `You are simulating an Instagram DM conversation between a prospect and a coaching bot.

COACH NICHE: ${niche}
TONE: ${tone}
STYLE: ${style}
${offerContext ? `OFFER CONTEXT:\n${offerContext}` : ""}
${systemPrompt ? `BOT INSTRUCTIONS:\n${systemPrompt}` : ""}
${exampleMessages ? `EXAMPLE MESSAGES FROM COACH:\n${exampleMessages}` : ""}

Generate a realistic 8–10 message Instagram DM conversation showing the bot working well.
The conversation should follow this natural arc:
1. Prospect reaches out or replies to a story (1–2 messages)
2. Bot asks about their goals and situation only — no pricing, no budget (3–4 messages)
3. Prospect shows genuine interest and asks about price or how it works (1–2 messages)
4. Bot answers naturally and sends the booking link at the right moment (1–2 messages)

STRICT rules for every bot message:
- maximum 1 sentence per reply — 2 only if absolutely necessary
- lowercase is fine and preferred for casual tone (e.g. "yeah that makes sense" not "Yes, that makes sense!")
- no formal punctuation — no semicolons, no colons before lists, no em dashes
- no bullet points or numbered lists inside any message
- no corporate phrases — never write "certainly", "great question", "absolutely", "of course", "sounds great", "sure thing"
- sound exactly like someone texting a friend, not a customer service agent
- ask only ONE question per bot message
- never ask about budget, investment, or pricing before the prospect brings it up themselves
- use the coach's actual offer details, price, and booking link from the context — do not make up generic placeholders

Return ONLY valid JSON in this exact format, no other text:
{
  "messages": [
    {"role": "prospect", "text": "..."},
    {"role": "bot", "text": "..."}
  ]
}`;

    if (!openai) {
      // Stub if no OpenAI key
      return safeJson(res, 200, {
        ok: true,
        messages: [
          { role: "prospect", text: "hey saw your story, what do you actually do?" },
          { role: "bot", text: `hey — i help people sort their ${niche === "fitness" ? "training and get in proper shape" : "finances and build real income"}. what's the main thing you're trying to fix right now?` },
          { role: "prospect", text: "honestly just not seeing results, been at it for months" },
          { role: "bot", text: "makes sense. are you training consistently or is that part of the issue too?" },
          { role: "prospect", text: "training yeah but diet is all over the place" },
          { role: "bot", text: "that's usually it. have you ever had a proper plan built around your schedule?" },
          { role: "prospect", text: "no never. how much does it cost?" },
          { role: "bot", text: offerPrice ? `it's ${offerPrice}` : "depends on what you need — what's your situation like?" },
          { role: "prospect", text: "that sounds reasonable actually. how do i get started?" },
          { role: "bot", text: `use this to book in and we'll go through everything — ${bookingUrl}` },
        ],
      });
    }

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: promptContent }],
      response_format: { type: "json_object" },
      max_tokens: 1200,
      temperature: 0.85,
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    if (!messages.length) {
      return safeJson(res, 500, { error: "AI returned an empty conversation. Try again." });
    }

    return safeJson(res, 200, { ok: true, messages });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * COACH STATS
 * ===========================
 */

app.get("/coach/api/stats", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;

    const { data: leads, error: leadsErr } = await supabase
      .from("leads")
      .select("id")
      .eq("client_id", clientId)
      .limit(5000);

    if (leadsErr) return safeJson(res, 500, leadsErr);

    const leadIds = (leads || []).map((l) => l.id);
    const leadsCount = leadIds.length;

    // pipeline_leads has no client_id — return total count across all coaches
    const { count: pipelineLeads, error: plErr } = await supabase
      .from("pipeline_leads")
      .select("id", { count: "exact", head: true });

    if (plErr) return safeJson(res, 500, plErr);

    // Coach targets — use defaults if no row exists yet
    const DEFAULT_TARGETS = { leads: 10, conversations: 50, pipelineLeads: 5 };
    const { data: targetsRow, error: tErr } = await supabase
      .from("coach_targets")
      .select("leads_target,conversations_target,pipeline_leads_target")
      .eq("client_id", clientId)
      .maybeSingle();

    if (tErr) return safeJson(res, 500, tErr);

    const targets = targetsRow
      ? {
          leads:         targetsRow.leads_target,
          conversations: targetsRow.conversations_target,
          pipelineLeads: targetsRow.pipeline_leads_target,
        }
      : DEFAULT_TARGETS;

    const [msgsRes, repliesRes, inboundRes] = await Promise.all([
      supabase
        .from("messages")
        .select("lead_id")
        .eq("client_id", clientId)
        .limit(50000),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("direction", "out"),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("direction", "in"),
    ]);

    if (msgsRes.error)   return safeJson(res, 500, msgsRes.error);
    if (repliesRes.error) return safeJson(res, 500, repliesRes.error);
    if (inboundRes.error) return safeJson(res, 500, inboundRes.error);

    const convoSet = new Set();
    for (const m of msgsRes.data || []) {
      if (m?.lead_id) convoSet.add(m.lead_id);
    }

    const conversations = convoSet.size;
    const repliesSent   = repliesRes.count ?? 0;
    const inbound       = inboundRes.count ?? 0;

    let replyRate = 0;
    if (inbound > 0) {
      replyRate = Math.round((repliesSent / inbound) * 1000) / 10; // 1 decimal
      if (replyRate > 100) replyRate = 100;
      if (replyRate < 0)   replyRate = 0;
    }

    return safeJson(res, 200, {
      ok: true,
      totals: {
        leads: leadsCount,
        conversations,
        repliesSent,
        replyRate,
        pipelineLeads: pipelineLeads ?? 0,
      },
      targets,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// POST /coach/api/stats/targets — upsert coach targets
app.post("/coach/api/stats/targets", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;
    const { leadsTarget, conversationsTarget, pipelineLeadsTarget } = req.body || {};

    const row = { client_id: clientId };
    if (leadsTarget         != null) row.leads_target          = parseInt(leadsTarget, 10);
    if (conversationsTarget != null) row.conversations_target   = parseInt(conversationsTarget, 10);
    if (pipelineLeadsTarget != null) row.pipeline_leads_target  = parseInt(pipelineLeadsTarget, 10);
    row.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from("coach_targets")
      .upsert(row, { onConflict: "client_id" });

    if (error) return safeJson(res, 500, { error: error.message });

    return safeJson(res, 200, { success: true });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * BILLING PORTAL
 * ===========================
 */

app.post("/coach/api/billing-portal", requireCoach, async (req, res) => {
  try {
    assertStripeConfigured();

    const customerId = req.coachConfig?.stripe_customer_id;
    if (!customerId) {
      return safeJson(res, 400, { error: "missing stripe customer id" });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: String(customerId),
return_url: `${APP_PUBLIC_URL}/dashboard`,
    });

    return safeJson(res, 200, {
      ok: true,
      url: portal.url,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});
/**
 * ===========================
 * FEATURE 3: BROADCAST API
 * ===========================
 */

app.get("/coach/api/broadcast/leads", requireCoach, async (req, res) => {
  try {
    const clientId = req.coachConfig?.client_id;
    const stage = req.query.stage || null;

    let query = supabase
      .from("leads")
      .select("id, ig_psid, stage, last_inbound_at, email, phone")
      .eq("client_id", clientId)
      .order("last_inbound_at", { ascending: false })
      .limit(200);

    if (stage && stage !== "all") {
      query = query.eq("stage", stage);
    }

    const { data, error } = await query;
    if (error) return safeJson(res, 500, { error: error.message });

    return safeJson(res, 200, { leads: data || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/coach/api/broadcast", requireCoach, async (req, res) => {
  try {
    const clientId = req.coachConfig?.client_id;
    const { message, lead_ids } = req.body || {};

    if (!message || !String(message).trim()) {
      return safeJson(res, 400, { error: "message is required" });
    }

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return safeJson(res, 400, { error: "at least one lead_id is required" });
    }

    if (lead_ids.length > 200) {
      return safeJson(res, 400, { error: "max 200 recipients per broadcast" });
    }

    // Per-client 50/hour rate limit
    let tracker = broadcastRateTracker.get(clientId);
    const now = Date.now();
    if (!tracker || now - tracker.windowStart >= 60 * 60 * 1000) {
      tracker = { count: 0, windowStart: now };
      broadcastRateTracker.set(clientId, tracker);
    }

    const remaining = BROADCAST_MAX_PER_HOUR - tracker.count;
    if (remaining <= 0) {
      return safeJson(res, 429, { error: "Broadcast limit reached (50/hour). Try again later." });
    }

    const toSend = lead_ids.slice(0, remaining);

    // Fetch the lead ig_psids
    const { data: leads, error: leadsError } = await supabase
      .from("leads")
      .select("id, ig_psid")
      .eq("client_id", clientId)
      .in("id", toSend);

    if (leadsError) return safeJson(res, 500, { error: leadsError.message });
    if (!leads || leads.length === 0) {
      return safeJson(res, 400, { error: "No valid leads found" });
    }

    const msgText = String(message).trim();
    let queued = 0;

    for (const lead of leads) {
      if (!lead.ig_psid) continue;
      try {
        await queueDm({ clientId, igPsid: lead.ig_psid, text: msgText });
        queued += 1;
      } catch (e) {
        console.error("broadcast: queueDm failed for lead", lead.id, e?.message || e);
      }
    }

    tracker.count += queued;

    return safeJson(res, 200, {
      ok: true,
      queued,
      skipped: lead_ids.length - queued,
      remaining: BROADCAST_MAX_PER_HOUR - tracker.count,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * FEATURE 4: QUEUE STATUS API
 * ===========================
 */

app.get("/coach/api/queue-status", requireCoach, async (req, res) => {
  try {
    const clientId = req.coachConfig?.client_id;

    const { data, error } = await supabase
      .from("dm_queue")
      .select("status")
      .eq("client_id", clientId)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error) return safeJson(res, 500, { error: error.message });

    const counts = { pending: 0, sent: 0, failed: 0 };
    for (const row of data || []) {
      if (counts[row.status] !== undefined) counts[row.status] += 1;
    }

    // Rate tracker info
    const tracker = broadcastRateTracker.get(clientId);
    const broadcastRemaining = tracker
      ? Math.max(0, BROADCAST_MAX_PER_HOUR - tracker.count)
      : BROADCAST_MAX_PER_HOUR;

    return safeJson(res, 200, {
      last_24h: counts,
      broadcast_remaining_this_hour: broadcastRemaining,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * PAYMENT LINK TOKEN RESOLVE
 * ===========================
 */

app.post("/api/payment-link/resolve", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return safeJson(res, 400, { error: "token required" });
    }

    const { data, error } = await supabase
      .from("payment_links")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !data) {
      return safeJson(res, 404, { error: "invalid payment link" });
    }

    return safeJson(res, 200, {
      ok: true,
      client_id: data.client_id,
      email: data.email || null,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

app.post("/api/stripe/session-token", async (req, res) => {
  try {
    assertStripeConfigured();

    const { session_id } = req.body || {};

    if (!session_id) {
      return safeJson(res, 400, { error: "session_id required" });
    }

    const session = await stripe.checkout.sessions.retrieve(String(session_id));

    const paymentToken = session?.metadata?.payment_token || "";

    if (!paymentToken) {
      return safeJson(res, 404, { error: "payment token not found" });
    }

    return safeJson(res, 200, {
      ok: true,
      token: paymentToken,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

/**
 * ===========================
 * STRIPE CHECKOUT
 * ===========================
 */

app.post("/api/stripe/create-checkout-session", async (req, res) => {
  try {
    assertStripeConfigured();

const { client_id, email, token } = req.body || {};

    if (!client_id) {
      return safeJson(res, 400, { error: "client_id required" });
    }

const session = await stripe.checkout.sessions.create({
  mode: "subscription",

  line_items: [
    {
      price: STRIPE_PRICE_MONTHLY,
      quantity: 1,
    },
  ],

  automatic_tax: { enabled: true },
  billing_address_collection: "required",
  customer_email: email || undefined,

  metadata: {
    client_id: String(client_id),
    payment_token: token ? String(token) : "",
  },

success_url: `${PAY_PUBLIC_URL}/success?paid=1&session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${PAY_PUBLIC_URL}/cancel?cancelled=1`,
});

    return safeJson(res, 200, {
      ok: true,
      url: session.url,
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});
/**
 * ===========================
 * STRIPE WEBHOOK
 * ===========================
 */

app.post("/webhook/stripe", async (req, res) => {
  try {
    assertStripeConfigured();

    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe signature error:", err);
      return res.status(400).send("Webhook error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const clientId = session?.metadata?.client_id;
      const customerId = session?.customer;
      const subscriptionId = session?.subscription;

      if (clientId) {
        let status = "active";
        let currentPeriodEnd = null;

        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);

          status = sub.status;

          currentPeriodEnd = new Date(
            sub.current_period_end * 1000
          ).toISOString();
        } catch {}

await updateClientStripeStatus(clientId, {
  stripe_customer_id: customerId,
  stripe_subscription_id: subscriptionId,
  stripe_subscription_status: status,
  stripe_current_period_end: currentPeriodEnd,
});

// auto-create coach user placeholder if it doesn't exist
const { data: existingUsers, error: existingUsersErr } = await supabase
  .from("coach_users")
  .select("*")
  .eq("client_id", clientId)
  .limit(1);

if (existingUsersErr) {
  console.error("coach_users lookup error:", existingUsersErr);
} else if ((!existingUsers || existingUsers.length === 0) && session.customer_details?.email) {
  await supabase.from("coach_users").insert({
    email: String(session.customer_details.email).toLowerCase(),
    password_hash: "",
    client_id: clientId,
  });
}
      }
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;

      const customerId = sub.customer;

      const clientId = await findClientIdByStripeCustomerId(customerId);

      if (clientId) {
        await updateClientStripeStatus(clientId, {
          stripe_subscription_status: sub.status,
          stripe_current_period_end: new Date(
            sub.current_period_end * 1000
          ).toISOString(),
        });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;

      const customerId = sub.customer;

      const clientId = await findClientIdByStripeCustomerId(customerId);

      if (clientId) {
        await updateClientStripeStatus(clientId, {
          stripe_subscription_status: "canceled",
        });
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Stripe webhook error:", e);
    res.status(500).send("Webhook error");
  }
});

/**
 * ===========================
 * ROOT TEST
 * ===========================
 */

app.get("/", (req, res) => {
  if (isPayHost(req)) {
    return res.redirect("/checkout");
  }

  if (isAppHost(req)) {
    return res.redirect("/login");
  }

  return res.send("IG DM Bot is running");
});

/**
 * ===========================
 * META WEBHOOK VERIFY
 * ===========================
 */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/**
 * ===========================
 * INSTAGRAM FOLLOW DM HANDLER
 * ===========================
 */

async function handleNewFollowerDm(igAccountId, followerId) {
  try {
    const { data: igAccount, error: igLookupError } = await supabase
      .from("ig_accounts")
      .select("client_id, ig_user_id, page_id, page_access_token")
      .eq("is_active", true)
      .or(`page_id.eq.${igAccountId},ig_user_id.eq.${igAccountId}`)
      .maybeSingle();

    if (igLookupError || !igAccount?.page_access_token) {
      console.error("follow_dm: no active IG account found", {
        igAccountId,
        error: igLookupError?.message || null,
      });
      return;
    }

    const clientId = igAccount.client_id;

    // Duplicate check — skip if this follower already has a lead record
    const { data: existingLead } = await supabase
      .from("leads")
      .select("id")
      .eq("client_id", clientId)
      .eq("ig_psid", followerId)
      .maybeSingle();

    if (existingLead) {
      log("follow_dm_skipped_duplicate", { igAccountId, followerId, clientId });
      return;
    }

    // Load coach's custom new-follower message, fall back to default
    const DEFAULT_FOLLOW_DM =
      "Hey - appreciate the follow! Was it an ad or a reel that brought you here?";
    let followDmText = DEFAULT_FOLLOW_DM;
    try {
      const cfg = await getClientConfig(clientId);
      const custom = String(cfg?.new_follower_dm_text || "").trim();
      if (custom) followDmText = custom;
    } catch {
      // keep default
    }

    // Create lead — try with source column first, fall back if column missing
    const { error: leadInsertErr } = await supabase
      .from("leads")
      .insert({
        client_id: clientId,
        ig_psid: followerId,
        stage: "new",
        source: "new_follower",
      });

    if (leadInsertErr) {
      // source column may not exist yet — retry without it
      const { error: retryErr } = await supabase
        .from("leads")
        .insert({ client_id: clientId, ig_psid: followerId, stage: "new" });
      if (retryErr) {
        console.error("follow_dm: lead insert failed", retryErr.message);
        // Don't return — still attempt to send the DM even if lead creation fails
      }
    }

    const { sendResp, sendData } = await sendInstagramTextMessage({
      accessToken: igAccount.page_access_token,
      recipientId: followerId,
      text: followDmText,
      useInstagramApi: !igAccount.page_id,
    });

    log("ig_follow_dm_sent", {
      igAccountId,
      followerId,
      clientId,
      sendOk: sendResp.ok,
      sendData,
    });
  } catch (e) {
    console.error("handleNewFollowerDm failed:", e?.message || e);
  }
}

/**
 * ===========================
 * FEATURE 1: POST COMMENT KEYWORD → DM + OPTIONAL PUBLIC REPLY
 * ===========================
 */

async function postPublicCommentReply(accessToken, commentId, replyText) {
  const resp = await fetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(commentId)}/replies?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: replyText }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

async function handlePostCommentKeyword(igAccountId, commentId, commenterId, commenterUsername, commentText) {
  try {
    const { data: igAccount, error: igLookupError } = await supabase
      .from("ig_accounts")
      .select("client_id, ig_user_id, page_id, page_access_token, fb_page_id, fb_page_token")
      .eq("is_active", true)
      .or(`page_id.eq.${igAccountId},ig_user_id.eq.${igAccountId},fb_page_id.eq.${igAccountId}`)
      .maybeSingle();

    if (igLookupError || !igAccount?.page_access_token) {
      console.error("comment_keyword: no active IG account found", {
        igAccountId,
        error: igLookupError?.message || null,
      });
      return;
    }

    const { data: cfg, error: cfgError } = await supabase
      .from("client_configs")
      .select("comment_keyword_dm_enabled, comment_keyword_trigger, comment_keyword_dm_text, comment_keyword_reply_enabled, comment_keyword_reply_text")
      .eq("client_id", igAccount.client_id)
      .maybeSingle();

    if (cfgError) {
      console.error("comment_keyword: failed to load config", { clientId: igAccount.client_id, error: cfgError?.message });
      return;
    }

    if (!cfg?.comment_keyword_dm_enabled) {
      console.log("comment_keyword: feature disabled for client", igAccount.client_id);
      return;
    }

    const trigger = normaliseTriggerText(cfg.comment_keyword_trigger || "");
    if (!trigger) {
      console.log("comment_keyword: no trigger keyword configured for client", igAccount.client_id);
      return;
    }

    const incoming = normaliseTriggerText(commentText);
    // Match if comment contains the keyword (more permissive than exact match for comments)
    if (!incoming.includes(trigger)) {
      console.log("comment_keyword: keyword not matched", { trigger, incoming: incoming.slice(0, 80) });
      return;
    }

    const dmText = String(cfg.comment_keyword_dm_text || "").trim();
    if (!dmText) {
      console.log("comment_keyword: no DM text configured for client", igAccount.client_id);
      return;
    }

    // Duplicate guard — skip if we already DM'd for this comment
    const dedupKey = `${igAccount.client_id}:kw:${commentId}`;
    if (sentCommentDmKeys.has(dedupKey)) {
      console.log("comment_keyword: duplicate guard — already sent DM for comment", commentId);
      return;
    }
    if (sentCommentDmKeys.size >= 5000) sentCommentDmKeys.clear();
    sentCommentDmKeys.add(dedupKey);

    // Send DM to commenter — only if we have a commenter ID (from.id may be absent
    // when polled via Graph API without the from field being returned)
    if (!commenterId) {
      console.log("comment_keyword: skipping DM — no commenterId (from.id missing)", { commentId });
    }
    const { sendResp, sendData } = commenterId
      ? await sendInstagramTextMessage({
          accessToken: igAccount.page_access_token,
          recipientId: commenterId,
          text: dmText,
          useInstagramApi: !igAccount.page_id,
        })
      : { sendResp: { ok: false }, sendData: { skipped: "no_commenter_id" } };

    log("ig_comment_keyword_dm_sent", {
      igAccountId,
      commentId,
      commenterId,
      clientId: igAccount.client_id,
      sendOk: sendResp.ok,
      sendData,
    });

    // Log to comment_activity_log for dashboard display
    await supabase.from("comment_activity_log").insert({
      coach_id:     igAccount.client_id,
      ig_username:  commenterUsername || commenterId,
      trigger_type: "Comment Keyword",
      keyword:      trigger,
      status:       "DM Sent",
    }).then(({ error }) => {
      if (error) console.error("comment_activity_log insert failed:", error.message, error.code);
    });

    // Optionally post a public reply to the comment (Facebook Login or chained Instagram+Facebook accounts)
    const commentReplyToken = igAccount.fb_page_token || igAccount.page_access_token;
    if (cfg.comment_keyword_reply_enabled && (igAccount.fb_page_token || igAccount.page_id)) {
      const replyText = String(cfg.comment_keyword_reply_text || "").trim();
      if (replyText) {
        const { ok: replyOk, data: replyData } = await postPublicCommentReply(
          commentReplyToken,
          commentId,
          replyText
        );
        log("ig_comment_public_reply_sent", {
          igAccountId,
          commentId,
          replyOk,
          replyData,
        });
      }
    }
  } catch (e) {
    console.error("handlePostCommentKeyword failed:", e?.message || e);
  }
}

async function handlePostCommentAutoDm(igAccountId, commentId, commenterId, commenterUsername, commentText) {
  try {
    const { data: igAccount, error: igLookupError } = await supabase
      .from("ig_accounts")
      .select("client_id, ig_user_id, page_id, page_access_token, fb_page_id, fb_page_token")
      .eq("is_active", true)
      .or(`page_id.eq.${igAccountId},ig_user_id.eq.${igAccountId},fb_page_id.eq.${igAccountId}`)
      .maybeSingle();

    if (igLookupError || !igAccount?.page_access_token) {
      console.error("comment_auto_dm: no active IG account found", { igAccountId, error: igLookupError?.message || null });
      return;
    }

    const { data: cfg } = await supabase
      .from("client_configs")
      .select("comment_reply_auto_dm_enabled, comment_reply_auto_dm_text")
      .eq("client_id", igAccount.client_id)
      .maybeSingle();

    if (!cfg?.comment_reply_auto_dm_enabled) {
      console.log("comment_auto_dm: feature disabled for client", igAccount.client_id);
      return;
    }

    const dmText = String(cfg.comment_reply_auto_dm_text || "").trim();
    if (!dmText) {
      console.log("comment_auto_dm: no DM text configured for client", igAccount.client_id);
      return;
    }

    // Skip if commenter is the account owner (own comments on own posts)
    if (commenterId === igAccount.ig_user_id || commenterId === igAccount.page_id) {
      console.log("comment_auto_dm: skipping own comment", { commenterId });
      return;
    }

    // Duplicate guard — skip if we already DM'd for this comment
    const dedupKey = `${igAccount.client_id}:auto:${commentId}`;
    if (sentCommentDmKeys.has(dedupKey)) {
      console.log("comment_auto_dm: duplicate guard — already sent DM for comment", commentId);
      return;
    }
    if (sentCommentDmKeys.size >= 5000) sentCommentDmKeys.clear();
    sentCommentDmKeys.add(dedupKey);

    if (!commenterId) {
      console.log("comment_auto_dm: skipping DM — no commenterId (from.id missing)", { commentId });
      return;
    }

    const { sendResp, sendData } = await sendInstagramTextMessage({
      accessToken: igAccount.page_access_token,
      recipientId: commenterId,
      text: dmText,
      useInstagramApi: !igAccount.page_id,
    });

    console.log("comment_auto_dm: DM sent", {
      igAccountId,
      commentId,
      commenterId,
      clientId: igAccount.client_id,
      sendOk: sendResp.ok,
      sendData,
    });

    log("ig_comment_auto_dm_sent", {
      igAccountId,
      commentId,
      commenterId,
      clientId: igAccount.client_id,
      sendOk: sendResp.ok,
    });

    // Log to comment_activity_log for dashboard display
    void supabase.from("comment_activity_log").insert({
      coach_id:    igAccount.client_id,
      ig_username: commenterUsername || commenterId,
      trigger_type: "Comment Auto-DM",
      keyword:     null,
      status:      "dm_sent",
    });
  } catch (e) {
    console.error("handlePostCommentAutoDm failed:", e?.message || e);
  }
}

/**
 * ===========================
 * FEATURE 4: DM SAFETY QUEUE
 * ===========================
 */

// Rate tracker: { igAccountId: { count: N, windowStart: Date } }
const dmQueueRateTracker = new Map();
const DM_QUEUE_MAX_PER_HOUR = 200;

// Comment DM dedup: prevents sending multiple DMs for the same comment
// if Meta retries the webhook. Keyed as "clientId:commentId".
// Max 5000 entries to avoid unbounded memory growth.
const sentCommentDmKeys = new Set();

async function queueDm({ clientId, igPsid, text }) {
  const { error } = await supabase.from("dm_queue").insert({
    client_id: clientId,
    ig_psid: igPsid,
    message: text,
    status: "pending",
  });
  if (error) {
    console.error("queueDm insert failed:", error);
    throw error;
  }
}

// Guard: prevents concurrent processDmQueue runs overlapping
let dmQueueRunning = false;

async function processDmQueue() {
  if (dmQueueRunning) {
    console.log("processDmQueue: already running, skipping");
    return;
  }
  dmQueueRunning = true;
  try {
    // Fetch pending messages ordered by created_at (oldest first), limit batch
    const { data: pendingItems, error } = await supabase
      .from("dm_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      console.error("processDmQueue fetch failed:", error.message || error);
      return;
    }
    if (!pendingItems || pendingItems.length === 0) {
      console.log("processDmQueue: no pending items");
      return;
    }

    console.log(`processDmQueue: processing ${pendingItems.length} pending item(s)`);

    for (const item of pendingItems) {
      try {
        // Check rate limit per account
        let tracker = dmQueueRateTracker.get(item.client_id);
        const now = Date.now();
        if (!tracker || now - tracker.windowStart >= 60 * 60 * 1000) {
          tracker = { count: 0, windowStart: now };
          dmQueueRateTracker.set(item.client_id, tracker);
        }
        if (tracker.count >= DM_QUEUE_MAX_PER_HOUR) {
          log("dm_queue_rate_limited", { clientId: item.client_id, count: tracker.count });
          continue;
        }

        // Look up IG account
        const igAccount = await getIgAccountByClientId(item.client_id);
        if (!igAccount?.page_access_token) {
          console.error("dm_queue: no access token for client", item.client_id);
          const { error: updErr } = await supabase.from("dm_queue").update({
            status: "failed",
            error: "No access token",
            processed_at: new Date().toISOString(),
          }).eq("id", item.id);
          if (updErr) console.error("dm_queue: status update failed", updErr.message);
          continue;
        }

        // Send the message
        console.log(`dm_queue: sending item ${item.id} to ${item.ig_psid}`);
        const { sendResp, sendData } = await sendInstagramTextMessage({
          accessToken: igAccount.page_access_token,
          recipientId: item.ig_psid,
          text: item.message,
          useInstagramApi: !igAccount.page_id,
        });

        tracker.count += 1;

        const { error: updErr } = await supabase.from("dm_queue").update({
          status: "sent",
          error: null,
          processed_at: new Date().toISOString(),
        }).eq("id", item.id);
        if (updErr) console.error("dm_queue: sent status update failed", updErr.message);

        // Emit: reply delivered to Instagram
        emitActivityEvent(item.client_id, {
          type: "reply_sent",
          leadName: leadNameCache.get(`${item.client_id}:${item.ig_psid}`) || `Lead ${String(item.ig_psid).slice(-6)}`,
          igPsid: item.ig_psid,
          preview: String(item.message).slice(0, 140),
        });

        log("dm_queue_processed", {
          id: item.id,
          clientId: item.client_id,
          igPsid: item.ig_psid,
          sendOk: sendResp.ok,
          sendData,
        });
        console.log(`dm_queue: sent item ${item.id} ok=${sendResp.ok}`);
      } catch (e) {
        console.error("dm_queue item failed:", item.id, e?.message || e);
        const { error: updErr } = await supabase.from("dm_queue").update({
          status: "failed",
          error: String(e?.message || e).slice(0, 200),
          processed_at: new Date().toISOString(),
        }).eq("id", item.id);
        if (updErr) console.error("dm_queue: failed status update error", updErr.message);
      }
    }
  } catch (e) {
    console.error("processDmQueue error:", e?.message || e);
  } finally {
    dmQueueRunning = false;
  }
}

/**
 * ===========================
 * FEATURE 3: BROADCAST MESSAGES
 * ===========================
 */

// Rate tracker per client for broadcasts: { clientId: { count: N, windowStart: Date } }
const broadcastRateTracker = new Map();
const BROADCAST_MAX_PER_HOUR = 50;

/**
 * ===========================
 * DM DEBOUNCE BUFFER
 * ===========================
 * Buffers incoming DMs per sender for 3 seconds. If a second message
 * arrives within the window the timer resets. After 3s of silence all
 * buffered texts are joined and processed as one combined message.
 * Echoes, story replies, comment triggers and keyword triggers bypass
 * the buffer and process immediately.
 */

const DM_DEBOUNCE_MS = 3000;
// Map key: "clientId:senderId" → { texts: string[], timer: TimeoutHandle, messaging, igAccount }
const dmDebounceBuffer = new Map();

function flushDmBuffer(bufferKey) {
  const entry = dmDebounceBuffer.get(bufferKey);
  if (!entry) return;
  dmDebounceBuffer.delete(bufferKey);

  const combinedText = entry.texts.filter(Boolean).join("\n");
  console.log("dm_debounce: flushing", { bufferKey, messageCount: entry.texts.length, combinedText: combinedText.slice(0, 120) });

  void processDmEvent(entry.messaging, entry.igAccount, combinedText);
}

/**
 * ===========================
 * INSTAGRAM WEBHOOK (POST)
 * ===========================
 */

app.post("/webhook", async (req, res) => {
  try {
    // ── RAW WEBHOOK LOGGER ────────────────────────────────────────────────────
    // Logs the complete raw payload BEFORE any processing so we can see exactly
    // what Meta sends for real comment events vs the test event simulator.
    console.log("[webhook:raw] headers:", JSON.stringify({
      "x-hub-signature-256": req.headers["x-hub-signature-256"] || null,
      "content-type": req.headers["content-type"] || null,
      "user-agent": req.headers["user-agent"] || null,
    }));
    console.log("[webhook:raw] body:", req.rawBody || "(rawBody not set — check bodyParser middleware)");
    // ─────────────────────────────────────────────────────────────────────────

    // X-Hub-Signature-256 verification
    // Try INSTAGRAM_APP_SECRET first, then META_APP_SECRET as fallback — both are
    // valid depending on which app the webhook is registered under in Meta App Dashboard.
    const sigHeader = req.headers["x-hub-signature-256"];
    if (sigHeader) {
      const secrets = [INSTAGRAM_APP_SECRET, META_APP_SECRET].filter(Boolean);
      let sigValid = false;
      for (const secret of secrets) {
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody || "").digest("hex");
        if (sigHeader === expected) { sigValid = true; break; }
      }
      if (!sigValid) {
        console.warn("webhook: X-Hub-Signature-256 mismatch — rejecting", { sigHeader: sigHeader.slice(0, 20) });
        return res.sendStatus(403);
      }
    } else {
      // No signature header — log but allow through (Meta omits it on some test events)
      console.warn("webhook: no X-Hub-Signature-256 header — proceeding without verification");
    }

    const body = req.body || {};
    const entryCount = Array.isArray(body.entry) ? body.entry.length : 0;
    const fields = (body.entry || []).flatMap((e) => (e.changes || []).map((c) => c.field)).filter(Boolean);
    console.log("webhook: received", { object: body.object || null, entryCount, fields, hasMessaging: (body.entry || []).some((e) => Array.isArray(e.messaging) && e.messaging.length > 0) });

    const events = getAllIgMessagingEvents(body);
    const followEvents = extractFollowEvents(body);
    const commentEvents = extractPostCommentEvents(body);

    if (!events.length && !followEvents.length && !commentEvents.length) {
      console.log("webhook: no actionable events found — returning 200");
      return res.sendStatus(200);
    }

    res.sendStatus(200);

    for (const { igAccountId, followerId } of followEvents) {
      void handleNewFollowerDm(igAccountId, followerId);
    }

    console.log("[comment_webhook] comment events extracted from this request:", commentEvents.length,
      commentEvents.length === 0
        ? "— if you expect comment events, the account may need to resubscribe with the 'comments' field (POST /coach/api/instagram/resubscribe)"
        : ""
    );
    for (const { igAccountId, commentId, commenterId, commenterUsername, commentText } of commentEvents) {
      console.log("[comment_webhook] dispatching comment event", { igAccountId, commentId, commenterId, commentText: commentText?.slice(0, 80) });
      void handlePostCommentKeyword(igAccountId, commentId, commenterId, commenterUsername, commentText);
      void handlePostCommentAutoDm(igAccountId, commentId, commenterId, commenterUsername, commentText);
    }

    for (const { messaging, entry } of events) {
      void (async () => {
        try {
          const senderId = messaging.sender?.id;
          // Instagram Business Login: recipient.id === entry.id === ig_user_id
          // Use entry.id as fallback in case recipient is missing
          const recipientId = messaging.recipient?.id || entry?.id;
          const text = extractIgText(messaging);
          const isEcho = isIgEcho(messaging);

          log("ig_webhook_received", {
            senderId,
            recipientId,
            hasText: !!text,
            isEcho,
            hasAttachments: !!messaging?.message?.attachments?.length,
            rawMid: messaging?.message?.mid || null,
            entryId: entry?.id || null,
          });

log("ig_event_debug", {
  senderId: messaging?.sender?.id || null,
  recipientId: messaging?.recipient?.id || null,
  text: messaging?.message?.text || null,
  hasAttachments: !!messaging?.message?.attachments?.length,
  attachmentType: messaging?.message?.attachments?.[0]?.type || null,
  isEcho: !!messaging?.message?.is_echo,
  referralSource:
    messaging?.referral?.source ||
    messaging?.postback?.referral?.source ||
    null,
  referralType:
    messaging?.referral?.type ||
    messaging?.postback?.referral?.type ||
    null,
  replyTo: messaging?.message?.reply_to || null,
  isStoryReplyTrigger: isStoryReplyTrigger(messaging),
  isCommentReplyTrigger: isCommentReplyTrigger(messaging),
  rawKeys: Object.keys(messaging || {}),
});

          if (!senderId) return;

          const hasMessage =
            !!String(text || "").trim() ||
            !!messaging?.message?.attachments?.length;

          if (!hasMessage) return;

          // Use .limit(1) + array result instead of .maybeSingle() so duplicate rows
          // don't cause an error — we just take the most recently created active row.
          const { data: igRows, error: igLookupError } = await supabase
            .from("ig_accounts")
            .select("id, client_id, ig_user_id, page_id, page_access_token")
            .eq("is_active", true)
            .or(`page_id.eq.${recipientId},ig_user_id.eq.${recipientId}`)
            .order("created_at", { ascending: false })
            .limit(1);

          let igAccount = Array.isArray(igRows) ? igRows[0] : null;

          console.log("webhook: ig_accounts lookup", {
            recipientId,
            senderId,
            found: !!igAccount,
            rowCount: Array.isArray(igRows) ? igRows.length : null,
            clientId: igAccount?.client_id || null,
            igUserId: igAccount?.ig_user_id || null,
            pageId: igAccount?.page_id || null,
            lookupError: igLookupError?.message || null,
            lookupErrorCode: igLookupError?.code || null,
          });

          // Auto-heal: when the recipient ID in the webhook doesn't match any active
          // ig_accounts row (ig_user_id or page_id), check if there is exactly one active
          // account with a valid token. If so, update its ig_user_id to the incoming
          // recipientId and continue — this handles ASID vs IGBID namespace mismatches
          // and avoids the manual resubscribe step after every new account connection.
          if (!igLookupError && !igAccount?.client_id) {
            const { data: fallbackRows, error: fallbackErr } = await supabase
              .from("ig_accounts")
              .select("id, client_id, ig_user_id, page_id, is_active, page_access_token")
              .eq("is_active", true)
              .order("created_at", { ascending: false })
              .limit(10);

            console.log("ig_accounts_auto_heal_candidates", {
              recipientId,
              senderId,
              fallbackErr: fallbackErr?.message || null,
              rowCount: Array.isArray(fallbackRows) ? fallbackRows.length : null,
              rows: Array.isArray(fallbackRows) ? fallbackRows.map((r) => ({
                id: r.id,
                client_id: r.client_id,
                ig_user_id: r.ig_user_id,
                page_id: r.page_id,
                is_active: r.is_active,
                has_token: !!r.page_access_token,
                token_empty: r.page_access_token === "",
              })) : null,
            });

            // Filter to rows that have a valid token (non-null, non-empty)
            const validRows = Array.isArray(fallbackRows)
              ? fallbackRows.filter((r) => r.page_access_token && r.page_access_token.length > 0)
              : [];

            console.log("ig_accounts_auto_heal_valid_candidates", {
              recipientId,
              validCount: validRows.length,
            });

            // Determine which row to heal:
            // - 1 candidate: heal it directly
            // - 2+ candidates: validate each token against Instagram API to find the owner
            let fallback = null;
            if (validRows.length === 1) {
              fallback = validRows[0];
            } else if (validRows.length > 1) {
              // For each candidate, try to POST-subscribe to /{recipientId}/subscribed_apps.
              // A 200 + success:true means this token IS the owner of recipientId.
              // GET /me?fields=id is NOT used here because it returns the ASID (App-Scoped User ID),
              // which is a different namespace from the IGBID (Instagram Business Account ID)
              // that webhooks deliver as recipient.id — they do not match for many accounts.
              for (const row of validRows) {
                try {
                  const checkUrl = `https://graph.instagram.com/v21.0/${encodeURIComponent(recipientId)}/subscribed_apps?access_token=${encodeURIComponent(row.page_access_token)}`;
                  const checkResp = await fetch(checkUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ subscribed_fields: "messages" }).toString(),
                  });
                  const checkData = await checkResp.json().catch(() => ({}));
                  console.log("ig_accounts_auto_heal_api_check", {
                    candidateId: row.id,
                    candidateIgUserId: row.ig_user_id,
                    recipientId,
                    httpStatus: checkResp.status,
                    success: checkData?.success ?? null,
                    error: checkData?.error?.message || null,
                  });
                  // Success means this token can subscribe to recipientId — it owns that account
                  if (checkResp.ok && checkData?.success === true) {
                    fallback = row;
                    break;
                  }
                } catch (apiErr) {
                  console.warn("ig_accounts_auto_heal_api_check_err", { candidateId: row.id, error: apiErr?.message });
                }
              }
            }

            if (fallback) {
              const { error: healErr } = await supabase
                .from("ig_accounts")
                .update({ ig_user_id: recipientId })
                .eq("id", fallback.id);
              if (!healErr) {
                igAccount = { ...fallback, ig_user_id: recipientId };
                console.log("ig_accounts_auto_healed", {
                  accountId: fallback.id,
                  clientId: fallback.client_id,
                  oldIgUserId: fallback.ig_user_id,
                  newIgUserId: recipientId,
                  pageId: fallback.page_id,
                });
                // Re-subscribe with the correct IGBID so future webhooks match directly
                void subscribeIgWebhook(fallback.page_access_token, recipientId).catch((e) =>
                  console.error("ig_accounts_auto_heal_resubscribe_err", e?.message || e)
                );
              } else {
                console.error("ig_accounts_auto_heal_failed", {
                  accountId: fallback.id,
                  error: healErr.message,
                });
              }
            } else {
              console.warn("ig_accounts_auto_heal_skipped", {
                recipientId,
                reason: validRows.length === 0 ? "no_valid_rows" : "api_check_found_no_match",
                validCount: validRows.length,
              });
            }
          }

          if (igLookupError || !igAccount?.client_id) {
            console.error("No active Instagram account/client mapping found", {
              recipientId,
              senderId,
              igLookupError: igLookupError?.message || null,
            });
            return;
          }

          // Echoes and trigger messages bypass debounce — process immediately
          const isTriggerMessage =
            isStoryReplyTrigger(messaging) ||
            isCommentReplyTrigger(messaging);

          if (!isEcho && !isTriggerMessage && text) {
            const bufferKey = `${igAccount.client_id}:${senderId}`;
            const existing = dmDebounceBuffer.get(bufferKey);

            if (existing) {
              // Another message already buffered — append text and reset timer
              clearTimeout(existing.timer);
              existing.texts.push(text);
              existing.timer = setTimeout(() => flushDmBuffer(bufferKey), DM_DEBOUNCE_MS);
              console.log("dm_debounce: buffered additional message", { bufferKey, total: existing.texts.length });
            } else {
              // First message from this sender — start the debounce window
              const timer = setTimeout(() => flushDmBuffer(bufferKey), DM_DEBOUNCE_MS);
              dmDebounceBuffer.set(bufferKey, { texts: [text], timer, messaging, igAccount });
              console.log("dm_debounce: started buffer", { bufferKey });
            }
            return; // will be processed when timer fires
          }

          // Immediate path: echo, trigger, or non-text message
          await processDmEvent(messaging, igAccount, text);
        } catch (err) {
          log("webhook_async_error", { clientId: igAccount?.client_id || null, error: err?.message || String(err) });
        }
      })();
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

// ─── Story media fetch helper ─────────────────────────────────────────────────
// Returns { storyId, storyUrl, storyMediaUrl } — any field may be null if the
// story has expired or the API call fails.
async function fetchStoryContext(accessToken, messaging) {
  const replyToStory = messaging?.message?.reply_to?.story || null;
  if (!replyToStory) return { storyId: null, storyUrl: null, storyMediaUrl: null };

  // reply_to.story may contain { id, url } directly in the webhook payload
  const storyId = replyToStory.id || null;
  const webhookUrl = replyToStory.url || null;

  console.log("fetchStoryContext: entry", { storyId, webhookUrl, hasToken: !!accessToken });

  if (!storyId || !accessToken) {
    console.warn("fetchStoryContext: missing storyId or accessToken — skipping API call", { storyId, hasToken: !!accessToken });
    return { storyId, storyUrl: webhookUrl, storyMediaUrl: null };
  }

  // Try graph.instagram.com first (Instagram Business Login token)
  try {
    const igUrl = `https://graph.instagram.com/v21.0/${encodeURIComponent(storyId)}?fields=media_url,thumbnail_url,media_type&access_token=${encodeURIComponent(accessToken)}`;
    console.log("fetchStoryContext: calling graph.instagram.com", { storyId, url: igUrl.replace(accessToken, "[REDACTED]") });
    const igResp = await fetch(igUrl);
    const igData = await igResp.json().catch(() => ({}));
    console.log("fetchStoryContext: graph.instagram.com raw response", { storyId, status: igResp.status, data: igData });

    const storyMediaUrl = igData?.media_url || igData?.thumbnail_url || null;
    if (storyMediaUrl) {
      console.log("fetchStoryContext: got media URL from graph.instagram.com", { storyId, storyMediaUrl });
      return { storyId, storyUrl: webhookUrl, storyMediaUrl };
    }
  } catch (e) {
    console.warn("fetchStoryContext: graph.instagram.com threw", e?.message || e);
  }

  // Fallback: try graph.facebook.com (works with some token types)
  try {
    const fbUrl = `https://graph.facebook.com/v23.0/${encodeURIComponent(storyId)}?fields=media_url,thumbnail_url,media_type&access_token=${encodeURIComponent(accessToken)}`;
    console.log("fetchStoryContext: calling graph.facebook.com fallback", { storyId });
    const fbResp = await fetch(fbUrl);
    const fbData = await fbResp.json().catch(() => ({}));
    console.log("fetchStoryContext: graph.facebook.com raw response", { storyId, status: fbResp.status, data: fbData });

    const storyMediaUrl = fbData?.media_url || fbData?.thumbnail_url || null;
    if (storyMediaUrl) {
      console.log("fetchStoryContext: got media URL from graph.facebook.com", { storyId, storyMediaUrl });
      return { storyId, storyUrl: webhookUrl, storyMediaUrl };
    }
  } catch (e) {
    console.warn("fetchStoryContext: graph.facebook.com threw", e?.message || e);
  }

  // Both APIs returned no media — story may have expired or token lacks permission.
  // The webhook CDN url (story_url) is stored and used as a display fallback.
  console.warn("fetchStoryContext: no media URL from either API", { storyId });
  return { storyId, storyUrl: webhookUrl, storyMediaUrl: null };
}

// ─── DM processing (called either directly or after debounce flush) ───────────
async function processDmEvent(messaging, igAccount, overrideText) {
  try {
  const senderId = messaging.sender?.id;
  const text = overrideText !== undefined ? overrideText : extractIgText(messaging);
  const isEcho = isIgEcho(messaging);

  let { data: lead, error: leadLookupError } = await supabase
            .from("leads")
            .select("*")
            .eq("client_id", igAccount.client_id)
            .eq("ig_psid", senderId)
            .maybeSingle();

          if (leadLookupError) {
            console.error("lead lookup failed:", leadLookupError);
            return;
          }

          if (!lead) {
            // For Instagram Login accounts, store 'Loading...' as a placeholder so the
            // dashboard never shows the raw IGSID. The background lookup replaces it with
            // the real username. Facebook Login accounts stay null (lookup is synchronous enough).
            const isInstagramLogin = !igAccount.page_id;
            const { data: newLead, error: newLeadError } = await supabase
              .from("leads")
              .insert({
                client_id: igAccount.client_id,
                ig_psid: senderId,
                ig_name: isInstagramLogin ? "Loading..." : null,
                stage: "new",
              })
              .select()
              .single();

            if (newLeadError) {
              console.error("lead create failed:", newLeadError);
              return;
            }

            lead = newLead;

            // Background: fetch real username from Instagram API and replace the placeholder
            void (async () => {
              try {
                const acc = await getIgAccountByClientId(lead.client_id).catch(() => null);
                if (!acc?.page_access_token) return;
                const name = await lookupIgName(acc.page_access_token, senderId, {
                  useInstagramApi: !acc.page_id,
                  coachIgUserId: acc.ig_user_id,
                });
                if (name) {
                  await supabase.from("leads").update({ ig_name: name }).eq("id", lead.id);
                  lead = { ...lead, ig_name: name };
                }
              } catch (e) {
                console.warn("ig_name lookup failed:", e?.message || e);
              }
            })();
          }

          // Detect story reply and fetch media context (non-blocking on failure)
          const isStoryReply = !isEcho && isStoryReplyTrigger(messaging);
          console.log("[trigger:story_reply] isStoryReplyTrigger result:", {
            isStoryReply,
            isEcho,
            referralSource: messaging?.referral?.source || messaging?.postback?.referral?.source || null,
            hasReplyToStory: !!(messaging?.message?.reply_to?.story),
            hasReplyToStoryId: !!(messaging?.message?.reply_to?.story_id),
            isStoryReplyField: messaging?.message?.is_story_reply ?? null,
            rawReplyTo: messaging?.message?.reply_to || null,
          });
          let storyContext = { storyId: null, storyUrl: null, storyMediaUrl: null };
          if (isStoryReply) {
            storyContext = await fetchStoryContext(igAccount.page_access_token, messaging).catch(() => storyContext);
          }

          // Pre-compute non-voice attachment info for message row enrichment
          const _attachmentsForRow = messaging?.message?.attachments || [];
          const _firstNonVoiceForRow = _attachmentsForRow.find((a) => {
            const t = String(a?.type || "").toLowerCase();
            return t !== "audio" && t !== "voice_clip" && !String(a?.payload?.mime_type || "").startsWith("audio/");
          });
          const inlineAttachmentUrl = _firstNonVoiceForRow?.payload?.url || null;
          const inlineAttachmentType = _firstNonVoiceForRow ? String(_firstNonVoiceForRow.type || "media").toLowerCase() : null;

          const messageRow = {
            lead_id: lead.id,
            client_id: lead.client_id,
            direction: isEcho ? "out" : "in",
            text: text || "[non-text message]",
            created_at: new Date().toISOString(),
            message_type: isStoryReply ? "story_reply" : (inlineAttachmentType ? inlineAttachmentType : "dm"),
            ...(isStoryReply && {
              story_id: storyContext.storyId,
              story_url: storyContext.storyUrl,
              story_media_url: storyContext.storyMediaUrl,
            }),
            ...(inlineAttachmentUrl && !isStoryReply && {
              story_url: inlineAttachmentUrl,
              ...(_firstNonVoiceForRow?.payload?.thumbnail_url
                ? { story_media_url: _firstNonVoiceForRow.payload.thumbnail_url }
                : {}),
            }),
          };

          const { error: insertIncomingError } = await supabase
            .from("messages")
            .insert(messageRow);

          if (insertIncomingError) {
            console.error("messages insert incoming failed:", JSON.stringify(insertIncomingError));
          }

          const prevLastInboundAt = lead.last_inbound_at;
          if (!isEcho) {
            try {
              lead = await updateLeadTracking(lead.id, {
                last_inbound_at: nowIso(),
              });
            } catch (e) {
              console.warn("last_inbound_at update failed:", e?.message || e);
            }
          }

          if (!lead.client_id) return;

          const cfg = await getClientConfig(lead.client_id);
          const niche = getEffectiveNiche(cfg);

          let historyMessages = [];
          try {
            historyMessages = await getLeadMessageHistory(lead.id, 30);
          } catch {}

          // Gap since previous inbound — drives the re-opener in the AI reply
          const conversationGap = computeConversationGap(prevLastInboundAt, historyMessages.length);

          if (!isEcho && cfg?.bot_paused) return;

          if (isEcho) {
            await setLeadManualOverride({
              leadId: lead.id,
              clientId: lead.client_id,
              enabled: true,
              reason: "Coach replied manually",
              actor: "system",
            });
            return;
          }

          // Emit: DM received (or story reply received)
          {
            const evtName = lead.ig_name || lead.email || `Lead ${String(lead.ig_psid || "").slice(-6)}`;
            leadNameCache.set(`${lead.client_id}:${senderId}`, evtName);
            const isStoryReply = isStoryReplyTrigger(messaging);
            emitActivityEvent(lead.client_id, {
              type: isStoryReply ? "story_reply_received" : "dm_received",
              leadName: evtName,
              igPsid: senderId,
              preview: text ? String(text).slice(0, 120) : "[non-text message]",
            });
          }

          // Voice note / audio attachment — send fixed reply, skip AI
          const attachments = messaging?.message?.attachments || [];
          const isVoiceNote = attachments.some((a) => {
            const t = String(a?.type || "").toLowerCase();
            // Meta sends audio attachments as type "audio"; voice notes may also
            // arrive with payload.url containing "audio" or mime type hints
            return (
              t === "audio" ||
              t === "voice_clip" ||
              String(a?.payload?.mime_type || "").startsWith("audio/")
            );
          });

          if (isVoiceNote) {
            console.log("ig_voice_note_received", { senderId, leadId: lead.id, clientId: lead.client_id });
            log("ig_voice_note_received", { senderId, leadId: lead.id, clientId: lead.client_id });

            const voiceAcc = await getIgAccountByClientId(lead.client_id).catch(() => null);
            if (voiceAcc?.page_access_token) {
              await sendInstagramTextMessage({
                accessToken: voiceAcc.page_access_token,
                recipientId: senderId,
                text: "Hey, I can't listen to voice notes right now - what's on your mind? Just type it out and I'll get back to you!",
                useInstagramApi: !voiceAcc.page_id,
              });
            }
            return;
          }

          // ── NON-VOICE MEDIA (image, reel, post, share) ───────────────────────────
          // When lead sends a non-voice attachment, detect the type and store it.
          // If there is accompanying text, proceed with text processing below.
          // If there is NO text, flag for coach review rather than going silent.
          const nonVoiceAttachments = attachments.filter((a) => {
            const t = String(a?.type || "").toLowerCase();
            return t !== "audio" && t !== "voice_clip";
          });
          const hasNonVoiceMedia = nonVoiceAttachments.length > 0;

          if (hasNonVoiceMedia && !text) {
            // No text — flag for coach and stay silent
            const mediaType = String(nonVoiceAttachments[0]?.type || "media").toLowerCase();
            const attachmentUrl = nonVoiceAttachments[0]?.payload?.url || null;
            log("media_no_text_received", { leadId: lead.id, clientId: lead.client_id, mediaType, attachmentUrl });
            try {
              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: true,
                reason: "Media received — coach input needed",
                actor: "system",
              });
            } catch (e) {
              console.warn("media_no_text confidence_pause: setLeadManualOverride failed", e?.message || e);
            }
            const leadName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
            emitActivityEvent(lead.client_id, {
              type: "confidence_pause",
              leadName,
              igPsid: senderId,
              preview: `[${mediaType} received]`,
            });
            await sendCoachPauseNotification(lead.id, lead.client_id);
            return;
          }

          // Detect inbound sales pitches and brush them off politely
          if (text && detectSalesPitch(text)) {
            log("sales_pitch_detected", { senderId, leadId: lead.id, clientId: lead.client_id, text: text.slice(0, 120) });
            const pitchAcc = await getIgAccountByClientId(lead.client_id).catch(() => null);
            if (pitchAcc?.page_access_token) {
              await sendInstagramTextMessage({
                accessToken: pitchAcc.page_access_token,
                recipientId: senderId,
                text: PITCH_DISMISSAL_MESSAGE,
                useInstagramApi: !pitchAcc.page_id,
              });
            }
            await setLeadManualOverride({
              leadId: lead.id,
              clientId: lead.client_id,
              enabled: true,
              reason: "Sales pitch detected - auto-dismissed",
              actor: "system",
            });
            return;
          }

          if (lead.manual_override) {
            const isPitchDismissed = String(lead.manual_override_reason || "").includes("Sales pitch detected");

            if (isPitchDismissed) {
              // If they're still pitching, stay silent entirely — no reply, no resume
              if (detectSalesPitch(text || "")) {
                log("sales_pitch_followup_silenced", { senderId, leadId: lead.id });
                return;
              }

              // If they pivot to a genuine question about the coach's services, resume
              if (detectGenuineLeadQuestion(text || "")) {
                log("sales_pitch_pivot_resume", { senderId, leadId: lead.id, text: String(text || "").slice(0, 80) });
                await setLeadManualOverride({
                  leadId: lead.id,
                  clientId: lead.client_id,
                  enabled: false,
                  reason: "Topic changed - resumed after pitch dismiss",
                  actor: "system",
                });
                // Fall through to normal AI reply handling
              } else {
                // Still-pitching case already handled above; this branch shouldn't be reached
                // because detectGenuineLeadQuestion now returns true for any non-pitch message.
                // Resume anyway to avoid silencing genuine leads.
                log("sales_pitch_pivot_resume_fallback", { senderId, leadId: lead.id });
                await setLeadManualOverride({
                  leadId: lead.id,
                  clientId: lead.client_id,
                  enabled: false,
                  reason: "Topic changed - resumed after pitch dismiss",
                  actor: "system",
                });
                // Fall through to normal AI reply handling
              }
            } else {
              // Normal manual override (coach replied, confidence pause, etc.)
              const H24 = 24 * 60 * 60 * 1000;
              const idleMs = msSince(lead.manual_override_at);

              if (idleMs <= H24) return;

              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: false,
                reason: "Auto resume",
                actor: "system",
              });
            }
          }

          const alreadyHasOutbound = (historyMessages || []).some(
            (m) => m?.role === "assistant"
          );

          // ---- Feature 2: Extract contact details from inbound messages ----
          if (text && cfg?.contact_collection_enabled) {
            try {
              const detectedEmail = !lead?.email ? extractEmail(text) : null;
              const detectedPhone = !lead?.phone ? extractPhone(text) : null;
              if (detectedEmail || detectedPhone) {
                const contactPatch = {};
                if (detectedEmail) contactPatch.email = detectedEmail;
                if (detectedPhone) contactPatch.phone = detectedPhone;
                const { error: contactUpdateError } = await supabase
                  .from("leads")
                  .update(contactPatch)
                  .eq("id", lead.id);
                if (!contactUpdateError) {
                  if (detectedEmail) lead = { ...lead, email: detectedEmail };
                  if (detectedPhone) lead = { ...lead, phone: detectedPhone };
                  log("contact_extracted", { leadId: lead.id, ...contactPatch });
                }
              }
            } catch (e) {
              console.warn("contact extraction failed:", e?.message || e);
            }
          }

// ── TRIGGER EVALUATION ────────────────────────────────────────────────────────
// NOTE: alreadyHasOutbound blocks all triggers when the lead has any prior
// outbound message. If this is true and triggers should fire, that is the bug.
console.log("[trigger:eval] inputs", {
  isEcho,
  alreadyHasOutbound,
  text: text ? text.slice(0, 80) : null,
  // Story auto-DM inputs
  story_reply_auto_dm_enabled: !!cfg?.story_reply_auto_dm_enabled,
  story_reply_auto_dm_text: cfg?.story_reply_auto_dm_text ? cfg.story_reply_auto_dm_text.slice(0, 60) : null,
  isStoryReplyTrigger_result: isStoryReplyTrigger(messaging),
  // Keyword DM inputs
  keyword_auto_dm_enabled: !!cfg?.keyword_auto_dm_enabled,
  keyword_trigger_text: cfg?.keyword_trigger_text || null,
  keyword_auto_dm_text: cfg?.keyword_auto_dm_text ? cfg.keyword_auto_dm_text.slice(0, 60) : null,
  shouldUseKeywordAutoDm_result: isPlainTextMessage(messaging) ? shouldUseKeywordAutoDm(cfg, text) : "(no plain text)",
  // Comment reply DM inputs
  comment_reply_auto_dm_enabled: !!cfg?.comment_reply_auto_dm_enabled,
  comment_reply_auto_dm_text: cfg?.comment_reply_auto_dm_text ? cfg.comment_reply_auto_dm_text.slice(0, 60) : null,
  isCommentReplyTrigger_result: isCommentReplyTrigger(messaging),
});

// Story reply and keyword DM fire regardless of conversation history —
// they are explicit trigger responses, not first-contact openers.
// Comment reply auto-DM keeps the alreadyHasOutbound guard (first-contact only).
const storyAutoDmMatched =
  !isEcho &&
  shouldUseStoryAutoDm(cfg, messaging);

const commentAutoDmMatched =
  !isEcho &&
  !alreadyHasOutbound &&
  shouldUseCommentAutoDm(cfg, messaging);

const keywordAutoDmMatched =
  !isEcho &&
  isPlainTextMessage(messaging) &&
  shouldUseKeywordAutoDm(cfg, text);

console.log("[trigger:eval] results", {
  storyAutoDmMatched,
  commentAutoDmMatched,
  keywordAutoDmMatched,
  anyTriggered: storyAutoDmMatched || commentAutoDmMatched || keywordAutoDmMatched,
  blockedByAlreadyHasOutbound: alreadyHasOutbound && (
    shouldUseStoryAutoDm(cfg, messaging) ||
    shouldUseCommentAutoDm(cfg, messaging) ||
    (isPlainTextMessage(messaging) && shouldUseKeywordAutoDm(cfg, text))
  ),
});

if (storyAutoDmMatched || commentAutoDmMatched || keywordAutoDmMatched) {
  const opener = storyAutoDmMatched
    ? getStoryAutoDmText(cfg)
    : commentAutoDmMatched
    ? getCommentAutoDmText(cfg)
    : getKeywordAutoDmText(cfg);

  const triggerName = storyAutoDmMatched ? "story_reply" : commentAutoDmMatched ? "comment_reply" : "keyword_dm";
  console.log(`[trigger:opener] ${triggerName} matched — opener text: ${opener ? JSON.stringify(opener.slice(0, 80)) : "(empty — will fall through to AI)"}`);

            if (opener) {
              const activeIgAccount = await getIgAccountByClientId(lead.client_id);

              if (!activeIgAccount?.page_access_token) {
                console.error(
                  "Missing Instagram access token for trigger opener:",
                  lead.client_id
                );
                return;
              }

              // Emit: sending opener DM
              {
                const evtName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
                emitActivityEvent(lead.client_id, {
                  type: "opener_sending",
                  leadName: evtName,
                  igPsid: senderId,
                });
              }

              const { sendResp, sendData } = await sendInstagramTextMessage({
                accessToken: activeIgAccount.page_access_token,
                recipientId: senderId,
                text: opener,
                useInstagramApi: !activeIgAccount.page_id,
              });

              // Emit: opener DM sent
              if (sendResp.ok) {
                const evtName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
                emitActivityEvent(lead.client_id, {
                  type: "opener_sent",
                  leadName: evtName,
                  igPsid: senderId,
                  preview: String(opener).slice(0, 140),
                });
              }

log("ig_trigger_opener_sent", {
  leadId: lead.id,
  senderId,
  triggerType: storyAutoDmMatched
    ? "story_reply"
    : commentAutoDmMatched
    ? "comment_reply"
    : "keyword_dm",
  sendOk: sendResp.ok,
  sendData,
});

              const { error: insertOutgoingError } = await supabase
                .from("messages")
                .insert({
                  lead_id: lead.id,
                  client_id: lead.client_id,
                  direction: "out",
                  text: opener,
                  created_at: new Date().toISOString(),
                });

              if (insertOutgoingError) {
                console.error(
                  "trigger opener insert outgoing failed:",
                  JSON.stringify(insertOutgoingError)
                );
              }

              try {
                lead = await updateLeadTracking(lead.id, {
                  last_outbound_at: nowIso(),
                  last_outbound_text: opener,
                  stage: "opener_sent",
                });
              } catch (e) {
                console.warn(
                  "trigger opener lead tracking failed:",
                  e?.message || e
                );
              }

              return;
            }
          }

          let leadMemory = null;
          try {
            leadMemory = await getLeadMemory(lead.id);
          } catch (e) {
            console.warn("getLeadMemory failed:", e?.message || e);
          }

          try {
            const extractedMemory = await extractLeadMemory({
              lead,
              historyMessages,
              existingMemory: leadMemory,
              currentMessage: text,
            });

            const detectedUserIntent = detectUserIntent(text);

            const derivedState = deriveConversationState({
              lead,
              leadMemory: extractedMemory || leadMemory,
              userIntent: detectedUserIntent,
            });

            leadMemory = await upsertLeadMemory({
              leadId: lead.id,
              clientId: lead.client_id,
              patch: {
                ...(extractedMemory || {}),
                last_user_intent: detectedUserIntent,
                conversation_state: derivedState,
              },
              existing: leadMemory,
            });
          } catch (e) {
            console.warn("lead memory update failed:", e?.message || e);
          }

          try {
            const nextStage = deriveLeadStage({
              lead,
              turnStrategy: null,
              leadMemory,
            });

            if (nextStage !== lead.stage) {
              lead = await updateLeadTracking(lead.id, {
                stage: nextStage,
              });
            }
          } catch (e) {
            console.warn("post-memory stage update failed:", e?.message || e);
          }

          const thinkAboutIt = detectThinkAboutIt(text);
          const asksPrice = detectPriceQuestion(text);
          const highIntent = detectHighIntent(text);
          const userIntent = detectUserIntent(text);

          const bookingAlreadySentBeforeReply =
            !!lead?.booking_sent ||
            !!leadMemory?.last_cta_at ||
            (leadMemory?.booking_link_sent_count || 0) > 0;

          if (
            bookingAlreadySentBeforeReply &&
            [
              "think_about_it",
              "price_question",
              "offer_question",
              "what_do_i_get_question",
              "start_process_question",
              "who_its_for_question",
            ].includes(userIntent)
          ) {
            try {
              leadMemory = await upsertLeadMemory({
                leadId: lead.id,
                clientId: lead.client_id,
                existing: leadMemory,
                patch: {
                  last_cta_response: userIntent,
                },
              });
            } catch (e) {
              console.warn("last_cta_response update failed:", e?.message || e);
            }
          }

          const conversationState = deriveConversationState({
            lead,
            leadMemory,
            userIntent,
          });

          let turnStrategy = decideTurnStrategyFromIntent({
            userIntent,
            conversationState,
            lead,
            leadMemory,
            text,
            bookingUrl: cfg?.booking_url || null,
            isFirstMessage: historyMessages.length === 0,
            products: Array.isArray(cfg?.products) ? cfg.products : [],
          });

          turnStrategy = preventRepeatedReplyType(turnStrategy, leadMemory);

          lead.last_message = text;

          // Off-topic guard: if the message is clearly nothing to do with this coach's
          // niche or any coaching service, pause immediately rather than hallucinating a reply.
          if (text && detectOffTopicMessage(text, niche)) {
            const leadName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
            log("confidence_pause_off_topic", { leadId: lead.id, clientId: lead.client_id, senderId, text: text.slice(0, 120) });
            try {
              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: true,
                reason: "Low confidence — coach input needed",
                actor: "system",
              });
            } catch (e) {
              console.warn("off_topic confidence_pause: setLeadManualOverride failed", e?.message || e);
            }
            emitActivityEvent(lead.client_id, {
              type: "confidence_pause",
              leadName,
              igPsid: senderId,
              preview: text ? String(text).slice(0, 120) : "[non-text message]",
            });
            await sendCoachPauseNotification(lead.id, lead.client_id);
            return;
          }

          // ── UNKNOWN PRODUCT GUARD ────────────────────────────────────────────────────
          // If the lead mentions a product-like noun that doesn't match any saved product,
          // flag for the coach rather than the AI inventing details.
          if (text && Array.isArray(cfg?.products) && cfg.products.length > 0) {
            const unknownProduct = detectUnknownProductMention(text, cfg.products);
            if (unknownProduct) {
              const leadName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
              log("confidence_pause_unknown_product", { leadId: lead.id, clientId: lead.client_id, senderId, mention: unknownProduct });
              try {
                await setLeadManualOverride({
                  leadId: lead.id,
                  clientId: lead.client_id,
                  enabled: true,
                  reason: "Lead mentioned unknown product — coach input needed",
                  actor: "system",
                });
              } catch (e) {
                console.warn("unknown_product confidence_pause: setLeadManualOverride failed", e?.message || e);
              }
              emitActivityEvent(lead.client_id, {
                type: "confidence_pause",
                leadName,
                igPsid: senderId,
                preview: text ? String(text).slice(0, 120) : "[non-text message]",
              });
              await sendCoachPauseNotification(lead.id, lead.client_id);
              return;
            }
          }

          // ── PERSONAL QUESTION GUARD ──────────────────────────────────────────────────
          // If the lead asks about personal details the bot cannot know from config,
          // flag immediately rather than hallucinating an answer.
          if (text && detectPersonalQuestion(text)) {
            const leadName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
            log("confidence_pause_personal_question", { leadId: lead.id, clientId: lead.client_id, senderId, text: text.slice(0, 120) });
            try {
              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: true,
                reason: "Personal question — coach input needed",
                actor: "system",
              });
            } catch (e) {
              console.warn("personal_question confidence_pause: setLeadManualOverride failed", e?.message || e);
            }
            emitActivityEvent(lead.client_id, {
              type: "confidence_pause",
              leadName,
              igPsid: senderId,
              preview: text ? String(text).slice(0, 120) : "[non-text message]",
            });
            await sendCoachPauseNotification(lead.id, lead.client_id);
            return;
          }

          // Emit: AI generating reply
          emitActivityEvent(lead.client_id, {
            type: "ai_generating",
            leadName: leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`,
            igPsid: senderId,
          });

          const aiResult = await generateAiReply({
            cfg,
            lead,
            historyMessages,
            leadMemory,
            turnStrategy,
            postCallMode: lead.call_completed,
            asksPrice,
            highIntent,
            bookingUrl: cfg?.booking_url || null,
            thinkAboutIt,
            userText: text,
            conversationGap,
          });

          // Unknown product mention or personal question — pause for coach if AI flagged it
          if (aiResult?.should_pause_for_coach) {
            const leadName = leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`;
            try {
              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: true,
                reason: "Coach input needed — personal question or unknown product",
                actor: "system",
              });
            } catch {}
            emitActivityEvent(lead.client_id, { type: "confidence_pause", leadName, igPsid: senderId, preview: text ? String(text).slice(0, 120) : "" });
            await sendCoachPauseNotification(lead.id, lead.client_id);
            return;
          }

          let reply = aiResult?.reply || null;

          if (!reply && turnStrategy?.type === "handle_think_about_it") {
            reply = getObjectionFollowUpReply(text, leadMemory, cfg);
          }

          const explicitLinkRequest = detectExplicitBookingLinkRequest(text);
          const bookingAlreadySent =
            !!lead?.booking_sent ||
            !!leadMemory?.last_cta_at ||
            (leadMemory?.booking_link_sent_count || 0) > 0;

          const canSendNewBookingPush =
            !!cfg?.booking_url && !bookingAlreadySent;
          const canResendBecauseAsked =
            !!cfg?.booking_url &&
            explicitLinkRequest &&
            bookingAlreadySent;

          if (canResendBecauseAsked) {
            reply = "use the link i sent earlier and get booked in";
          } else if (aiResult?.should_send_booking_link && canSendNewBookingPush) {
            if (turnStrategy?.type === "soft_close_to_booking") {
              reply = buildWarmCloseFromMemory(cfg.booking_url, leadMemory);
            } else {
              reply = getEscalatedBookingReply(
                cfg.booking_url,
                leadMemory,
                "normal"
              );
            }
          } else if (highIntent && canSendNewBookingPush) {
            reply = getEscalatedBookingReply(cfg.booking_url, leadMemory, "normal");
          }

          // send_product_link_now: find first product with a URL and send it
          if (!reply && turnStrategy?.type === "send_product_link_now") {
            const cfgProducts = Array.isArray(cfg?.products) ? cfg.products : [];
            const productWithUrl = cfgProducts.find((p) => p?.url);
            if (productWithUrl?.url) {
              reply = `here's the link: ${productWithUrl.url}`;
            } else if (cfg?.booking_url) {
              reply = `here's the link: ${cfg.booking_url}`;
            }
          }

          if (!reply || looksIncompleteReply(reply)) {
            if (turnStrategy?.type === "handle_think_about_it") {
              reply = getObjectionFollowUpReply(text, leadMemory, cfg);
            }

            if (!reply) {
              reply =
                buildDeterministicReply({
                  turnStrategy,
                  cfg,
                }) ||
                getFallbackReply({
                  turnStrategy,
                  cfg,
                  leadMemory,
                });
            }
          }

          if (!reply) {
            // Feature 1+4: confidence pause — bot couldn't produce a reply,
            // flag the lead for coach review instead of going silent silently.
            const leadName =
              leadNameCache.get(`${lead.client_id}:${senderId}`) ||
              lead.ig_name ||
              `Lead ${String(senderId).slice(-6)}`;
            try {
              await setLeadManualOverride({
                leadId: lead.id,
                clientId: lead.client_id,
                enabled: true,
                reason: "Low confidence — coach input needed",
                actor: "system",
              });
            } catch (e) {
              console.warn("confidence_pause: setLeadManualOverride failed", e?.message || e);
            }
            emitActivityEvent(lead.client_id, {
              type: "confidence_pause",
              leadName,
              igPsid: senderId,
              preview: text ? String(text).slice(0, 120) : "[non-text message]",
            });
            log("confidence_pause", { leadId: lead.id, clientId: lead.client_id, senderId });
            await sendCoachPauseNotification(lead.id, lead.client_id);
            return;
          }

          // Emit: AI reply generated
          emitActivityEvent(lead.client_id, {
            type: "ai_reply_ready",
            leadName: leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`,
            igPsid: senderId,
            preview: String(reply).slice(0, 140),
          });

          const shouldHumanise = ![
            "answer_price_after_cta",
            "handle_price_then_cta",
            "answer_offer_question_after_cta",
            "answer_what_you_sell_after_cta",
            "answer_what_do_i_get_after_cta",
            "answer_start_process_after_cta",
            "answer_who_its_for_after_cta",
            "handle_think_about_it",
          ].includes(String(turnStrategy?.type || ""));

          if (shouldHumanise) {
            reply = humaniseText(reply);
          }

          const recentAssistantHistory = (historyMessages || [])
            .filter((m) => m?.role === "assistant")
            .slice(-5);

          if (
            isReplyTooSimilar(reply, recentAssistantHistory, turnStrategy?.type) ||
            looksIncompleteReply(reply)
          ) {
            const retryAiResult = await generateAiReply({
              cfg,
              lead,
              historyMessages: [
                ...(historyMessages || []),
                {
                  role: "system",
                  content:
                    "Your last draft was too repetitive or incomplete. Answer the user's meaning directly in a new way. Do not repeat recent assistant wording.",
                },
              ],
              leadMemory,
              turnStrategy,
              postCallMode: lead.call_completed,
              asksPrice,
              highIntent,
              bookingUrl: cfg?.booking_url || null,
              thinkAboutIt,
              userText: text,
            });

            if (retryAiResult?.reply && !looksIncompleteReply(retryAiResult.reply)) {
              reply = retryAiResult.reply;
            } else {
              const fallback =
                buildDeterministicReply({
                  turnStrategy,
                  cfg,
                }) ||
                getFallbackReply({
                  turnStrategy,
                  cfg,
                  leadMemory,
                });

              if (fallback) {
                const fallbackIsStructured =
                  turnStrategy?.type === "answer_price_after_cta" ||
                  turnStrategy?.type === "handle_price_then_cta" ||
                  turnStrategy?.type === "answer_offer_question_after_cta" ||
                  turnStrategy?.type === "answer_what_do_i_get_after_cta" ||
                  turnStrategy?.type === "answer_start_process_after_cta" ||
                  turnStrategy?.type === "answer_who_its_for_after_cta" ||
                  turnStrategy?.type === "answer_what_you_sell_after_cta";

                reply = fallbackIsStructured ? fallback : humaniseText(fallback);
              }
            }
          }

          // Feature 5: if reply is still too similar after retry + fallback, force a variation
          if (reply && isReplyTooSimilar(reply, recentAssistantHistory, turnStrategy?.type)) {
            const variationSuffixes = [
              " — what do you think?",
              " let me know",
              " — does that make sense?",
              " still here if you need anything",
            ];
            reply = reply + variationSuffixes[Math.floor(Math.random() * variationSuffixes.length)];
          }

          try {
            const nextStage = deriveLeadStage({
              lead,
              turnStrategy,
              leadMemory,
            });

            lead = await updateLeadTracking(lead.id, {
              stage: nextStage,
            });
          } catch (e) {
            console.warn("lead stage update failed:", e?.message || e);
          }

          const messagesToSend = splitIntoMessages(reply);

          for (let i = 0; i < messagesToSend.length; i++) {
            const msg = messagesToSend[i];

            const words = msg.split(" ").length;
            const typingDelay = Math.min(words * 250, 3000);

            // Feature 6: coach-configurable response delay (30s–180s, default 90s)
            const baseDelay = Math.max(30000, Math.min(180000, Number(cfg?.response_delay_ms) || 90000));
            const jitter = baseDelay * 0.15 * (Math.random() * 2 - 1); // ±15%
            const extraDelay = Math.round(baseDelay + jitter);

            const delay = typingDelay + extraDelay;
            await new Promise((res) => setTimeout(res, delay));

            // Feature 4: route through DM safety queue
            await queueDm({ clientId: lead.client_id, igPsid: senderId, text: msg });

            // Emit: reply queued for delivery
            emitActivityEvent(lead.client_id, {
              type: "reply_queued",
              leadName: leadNameCache.get(`${lead.client_id}:${senderId}`) || lead.ig_name || `Lead ${String(senderId).slice(-6)}`,
              igPsid: senderId,
              preview: String(msg).slice(0, 140),
            });

            // Trigger queue processor immediately — don't wait for the 30-second interval
            void processDmQueue().catch((e) =>
              console.error("dm_queue: post-queue trigger failed", e?.message || e)
            );

            log("ig_message_queued", {
              leadId: lead.id,
              senderId,
              messagePreview: String(msg).slice(0, 120),
            });

            const { error: insertOutgoingError } = await supabase
              .from("messages")
              .insert({
                lead_id: lead.id,
                client_id: lead.client_id,
                direction: "out",
                text: msg,
                created_at: new Date().toISOString(),
              });

            if (insertOutgoingError) {
              console.error("messages insert outgoing failed:", JSON.stringify(insertOutgoingError));
            }

            try {
              const sentBookingLink =
                !!cfg?.booking_url &&
                String(msg).includes(String(cfg.booking_url));

              lead = await updateLeadTracking(lead.id, {
                last_outbound_at: nowIso(),
                last_outbound_text: msg,
                booking_sent: sentBookingLink ? true : lead.booking_sent,
                booking_sent_at: sentBookingLink ? nowIso() : lead.booking_sent_at,
                booking_sent_count: sentBookingLink
                  ? (lead.booking_sent_count || 0) + 1
                  : lead.booking_sent_count || 0,
                stage: sentBookingLink ? "booking_sent" : lead.stage,
              });

              const replyTrackingPatch = buildReplyTrackingPatch(
                leadMemory,
                turnStrategy
              );

              leadMemory = await upsertLeadMemory({
                leadId: lead.id,
                clientId: lead.client_id,
                existing: leadMemory,
                patch: {
                  ...replyTrackingPatch,
                  conversation_state: sentBookingLink
                    ? "booking_cta_sent"
                    : leadMemory?.conversation_state || null,

                  cta_attempts: sentBookingLink
                    ? (leadMemory?.cta_attempts || 0) + 1
                    : leadMemory?.cta_attempts || 0,

                  last_cta_response: sentBookingLink
                    ? "sent_booking_link"
                    : leadMemory?.last_cta_response || null,

                  ...(sentBookingLink
                    ? {
                        last_cta_type: "booking_link",
                        last_cta_at: nowIso(),
                        booking_link_sent_count:
                          (leadMemory?.booking_link_sent_count || 0) + 1,
                      }
                    : {}),
                },
              });
            } catch (e) {
              console.warn("lead outbound tracking failed:", e?.message || e);
            }

            try {
              if (
                msg.length < 120 &&
                !msg.includes("http") &&
                !isUnsafeReply(msg) &&
                !isUnsafeReply(text)
              ) {
                await saveLearnedExample({
                  clientId: lead.client_id,
                  leadId: lead.id,
                  userMessage: text,
                  assistantMessage: msg,
                });
              }
            } catch (e) {
              console.warn("learned example save failed:", e?.message || e);
            }
          }
        } catch (err) {
          log("webhook_async_error", { clientId: lead?.client_id || null, error: err?.message || String(err) });
        }
}
/**
 * ===========================
 * START SERVER
 * ===========================
 */

// ── Instagram OAuth entry point for login/signup (no auth required) ──────
app.get("/auth/instagram/start", (req, res) => {
  try {
    if (!INSTAGRAM_APP_ID || !META_REDIRECT_URI) {
      return res.redirect("/coach/login.html?instagram_error=Instagram+app+not+configured");
    }
    const state = jwt.sign({ type: "instagram_signup" }, COACH_JWT_SECRET, { expiresIn: "15m" });
    const authUrl = new URL("https://www.instagram.com/oauth/authorize");
    authUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
    authUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_messages");
    authUrl.searchParams.set("enable_fb_login", "0");
    authUrl.searchParams.set("force_reauth", "1");
    authUrl.searchParams.set("state", state);
    return res.redirect(authUrl.toString());
  } catch (e) {
    return res.redirect(`/coach/login.html?instagram_error=${encodeURIComponent(String(e?.message || e))}`);
  }
});

app.get("/auth/instagram/callback", async (req, res) => {
  try {
    if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET || !META_REDIRECT_URI) {
      return res.status(500).send("Instagram app env vars not configured");
    }

    const error = String(req.query.error || "");
    const errorReason = String(req.query.error_reason || "");
    const errorDescription = String(req.query.error_description || "");

    if (error) {
      // Route error back to the right page based on which flow initiated it
      let errorDest = "/coach/login.html";
      try {
        const maybeDecoded = jwt.verify(String(req.query.state || ""), COACH_JWT_SECRET);
        if (maybeDecoded?.type === "instagram_connect") errorDest = "/settings";
      } catch {}
      return res.redirect(
        `${errorDest}?instagram_error=${encodeURIComponent(errorDescription || errorReason || error)}`
      );
    }

    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    if (!code) {
      return res.status(400).send("Missing code");
    }

    if (!state) {
      return res.status(400).send("Missing state");
    }

    let decoded;
    try {
      decoded = verifyInstagramState(state);
    } catch {
      return res.status(400).send("Invalid or expired state");
    }

    const isSignupFlow = decoded.type === "instagram_signup";
    const clientId = decoded.client_id; // undefined for signup flow

    // ── SIGNUP FLOW: Instagram Business Login (api.instagram.com) ────────────
    if (isSignupFlow) {
      // Stage 1: exchange code for short-lived token — read raw body first so we can
      // extract user_id as a string before JSON.parse() corrupts large IDs via float64.
      const shortTokenResp = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: INSTAGRAM_APP_ID,
          client_secret: INSTAGRAM_APP_SECRET,
          grant_type: "authorization_code",
          redirect_uri: META_REDIRECT_URI,
          code,
        }).toString(),
      });
      const shortTokenRaw = await shortTokenResp.text();
      // Extract user_id as a raw string BEFORE JSON.parse() (large IDs > 2^53 lose
      // precision as float64 — regex preserves all digits)
      const igbidMatch = /"user_id"\s*:\s*(\d+)/.exec(shortTokenRaw);
      const igbidFromToken = igbidMatch ? igbidMatch[1] : null;
      const shortTokenData = JSON.parse(shortTokenRaw);

      if (!shortTokenResp.ok || !shortTokenData?.access_token) {
        console.error("ig_signup: short token exchange failed", shortTokenData);
        return res.redirect(
          `/coach/login.html?instagram_error=${encodeURIComponent("Failed to connect Instagram. Please try again.")}`
        );
      }

      const shortToken = shortTokenData.access_token;

      // Stage 2: exchange for long-lived token (~60 days)
      const longTokenResp = await fetch(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(INSTAGRAM_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`
      );
      const longTokenData = await longTokenResp.json().catch(() => ({}));
      const longToken = longTokenData?.access_token || shortToken;
      if (!longTokenData?.access_token) {
        console.warn("ig_signup: long-lived token exchange failed, using short-lived", longTokenData);
      }

      // Get IG user info — /me returns ASID (app-scoped user ID) as a JSON string.
      // The IGBID (Instagram Business Account ID, what webhooks deliver as recipient.id)
      // is in user_id from the short token response — extracted above via regex.
      const igInfoResp = await fetch(
        `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(longToken)}`
      );
      const igInfo = await igInfoResp.json().catch(() => ({}));
      const igUsername = igInfo?.username || null;
      const igAsid = igInfo?.id ? String(igInfo.id) : null;

      if (!igAsid) {
        console.error("ig_signup: failed to get user id from /me", igInfo);
        return res.redirect(
          `/coach/login.html?instagram_error=${encodeURIComponent("Failed to retrieve Instagram account ID. Please try again.")}`
        );
      }

      // Prefer the IGBID (webhook recipient.id) over the ASID for storage.
      // If not available fall back to ASID — auto-heal will correct on first webhook.
      const igUserId = igbidFromToken || igAsid;
      console.log("ig_signup: user IDs resolved", { igAsid, igbidFromToken, storingAs: igUserId });

      // Verify which ID the token actually resolves to for webhook routing by attempting
      // a POST subscription. If it succeeds, igUserId is correct. If it fails, it means
      // the stored ID is the ASID (not IGBID) — auto-heal will fix on the first real webhook.
      // This is diagnostic only — we do not block signup on failure.
      try {
        const verifyResp = await fetch(
          `https://graph.instagram.com/v21.0/${encodeURIComponent(igUserId)}/subscribed_apps?access_token=${encodeURIComponent(longToken)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ subscribed_fields: "messages" }).toString(),
          }
        );
        const verifyData = await verifyResp.json().catch(() => ({}));
        console.log("ig_signup: webhook subscription verify", {
          igUserId,
          httpStatus: verifyResp.status,
          success: verifyData?.success ?? null,
          error: verifyData?.error?.message || null,
          warning: !verifyResp.ok
            ? "Subscription failed — stored ID may be ASID not IGBID. Auto-heal will correct on first webhook delivery."
            : null,
        });
      } catch (verifyErr) {
        console.warn("ig_signup: webhook subscription verify threw", verifyErr?.message);
      }

      // Check if this IG account is already linked to a coach
      const { data: existingIgRow } = await supabase
        .from("ig_accounts")
        .select("client_id")
        .eq("ig_user_id", igUserId)
        .maybeSingle();

      let resolvedClientId;

      if (existingIgRow?.client_id) {
        // Returning coach — verify subscription then log them in
        resolvedClientId = existingIgRow.client_id;
        const cfg = await getClientConfig(resolvedClientId);
        if (!isAllowedStripeStatus(cfg?.stripe_subscription_status)) {
          return res.redirect("/coach/login.html?instagram_error=Your+subscription+is+inactive.+Please+contact+support.");
        }
        // Refresh token — UPDATE directly by client_id (always exists at this point)
        await supabase.from("ig_accounts").update({
          ig_user_id: igUserId,
          ig_username: igUsername,
          page_id: null,
          page_access_token: longToken,
          is_active: true,
          token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        }).eq("client_id", resolvedClientId);
        console.log("ig_signup: returning coach logged in", { resolvedClientId, igUserId });
      } else {
        // New coach — create client + config + ig_account
        const { data: newClient, error: clientErr } = await supabase
          .from("clients")
          .insert({ name: igUsername || "New Coach", timezone: "Europe/London" })
          .select()
          .single();
        if (clientErr) {
          console.error("ig_signup: client insert failed", clientErr);
          return res.redirect(
            `/coach/login.html?instagram_error=${encodeURIComponent("Failed to create account. Please try again.")}`
          );
        }

        resolvedClientId = newClient.id;

        const { error: configErr } = await supabase.from("client_configs").insert({
          client_id: resolvedClientId,
          stripe_subscription_status: "demo",
          system_prompt: "You are a helpful assistant that qualifies leads and books sales calls on behalf of this coach. Keep replies short, casual and conversational. Ask one question at a time to understand the lead's goals and situation before moving towards booking a call.",
          tone: "direct",
          style: "short, punchy",
          vocabulary: "casual UK coach",
          niche: "generic",
          story_reply_auto_dm_enabled: false,
          comment_reply_auto_dm_enabled: false,
          keyword_auto_dm_enabled: false,
        });
        if (configErr) {
          console.error("ig_signup: client_configs insert failed", configErr);
          // Clean up the orphaned client row so signup can be retried
          await supabase.from("clients").delete().eq("id", resolvedClientId);
          return res.redirect(
            `/coach/login.html?instagram_error=${encodeURIComponent("Failed to create account config. Please try again.")}`
          );
        }

        // page_id: null marks this as Instagram Login flow (uses graph.instagram.com for messaging)
        // New coach — client_id is brand new so INSERT is safe here
        await supabase.from("ig_accounts").insert({
          client_id: resolvedClientId,
          ig_user_id: igUserId,
          ig_username: igUsername,
          page_id: null,
          page_access_token: longToken,
          is_active: true,
          token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        });

        console.log("ig_signup: new coach created", { resolvedClientId, igUsername });
      }

      // Subscribe webhook (non-blocking)
      void subscribeIgWebhook(longToken, igUserId).catch((e) =>
        console.error("ig_signup: webhook subscription threw", e?.message || e)
      );

      // Instagram signup complete — chain to Facebook OAuth to get page token + comment permissions.
      // The Facebook callback will redirect to dashboard with the coach JWT after it completes.
      // If the coach skips or denies Facebook, the callback redirects to dashboard anyway.
      if (META_APP_ID && META_FB_REDIRECT_URI) {
        const fbState = signFbChainState({ clientId: resolvedClientId, isNew: true });
        return res.redirect(buildFacebookOAuthUrl(fbState));
      }
      // Fallback if Facebook OAuth is not configured
      const token = signCoachToken(resolvedClientId);
      return res.redirect(`/dashboard?token=${encodeURIComponent(token)}&instagram_connected=1`);
    }

    // ── CONNECT FLOW: authenticated coach reconnecting via Instagram Business Login ──
    // Same Instagram OAuth token exchange as signup; just updates existing account.

    // Stage 1: short-lived token — read raw body first to extract user_id as a string
    // before JSON.parse() corrupts large IDs (> 2^53) via float64.
    const shortTokenResp = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: META_REDIRECT_URI,
        code,
      }).toString(),
    });
    const shortTokenRaw = await shortTokenResp.text();
    const igbidMatch = /"user_id"\s*:\s*(\d+)/.exec(shortTokenRaw);
    const igbidFromToken = igbidMatch ? igbidMatch[1] : null;
    const shortTokenData = JSON.parse(shortTokenRaw);

    if (!shortTokenResp.ok || !shortTokenData?.access_token) {
      console.error("ig_connect: short token exchange failed", shortTokenData);
      return res.redirect(
        `/settings?instagram_error=${encodeURIComponent("Failed to connect Instagram. Please try again.")}`
      );
    }

    const shortToken = shortTokenData.access_token;

    // Stage 2: long-lived token (~60 days)
    const longTokenResp = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(INSTAGRAM_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`
    );
    const longTokenData = await longTokenResp.json().catch(() => ({}));
    const longToken = longTokenData?.access_token || shortToken;
    if (!longTokenData?.access_token) {
      console.warn("ig_connect: long-lived token exchange failed, using short-lived", longTokenData);
    }

    // /me returns the ASID; the IGBID (what webhooks deliver as recipient.id) comes
    // from user_id in the short token response (extracted above via regex).
    const igInfoResp = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(longToken)}`
    );
    const igInfo = await igInfoResp.json().catch(() => ({}));
    const igUsername = igInfo?.username || null;
    const igAsid = igInfo?.id ? String(igInfo.id) : null;

    if (!igAsid) {
      console.error("ig_connect: failed to get user id from /me", igInfo);
      return res.redirect(
        `/settings?instagram_error=${encodeURIComponent("Failed to retrieve Instagram account ID. Please try again.")}`
      );
    }

    // Store IGBID (webhook recipient.id) — fall back to ASID if not available
    const igUserId = igbidFromToken || igAsid;
    console.log("ig_connect: user IDs resolved", { igAsid, igbidFromToken, storingAs: igUserId, clientId });

    // Verify the stored ID resolves correctly for webhooks by attempting a POST subscription.
    // If this fails, the ID is likely an ASID — auto-heal will correct on first webhook delivery.
    try {
      const verifyResp = await fetch(
        `https://graph.instagram.com/v21.0/${encodeURIComponent(igUserId)}/subscribed_apps?access_token=${encodeURIComponent(longToken)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ subscribed_fields: "messages" }).toString(),
        }
      );
      const verifyData = await verifyResp.json().catch(() => ({}));
      console.log("ig_connect: webhook subscription verify", {
        igUserId,
        clientId,
        httpStatus: verifyResp.status,
        success: verifyData?.success ?? null,
        error: verifyData?.error?.message || null,
        warning: !verifyResp.ok
          ? "Subscription failed — stored ID may be ASID not IGBID. Auto-heal will correct on first webhook delivery."
          : null,
      });
    } catch (verifyErr) {
      console.warn("ig_connect: webhook subscription verify threw", verifyErr?.message);
    }

    const igAccountPayload = {
      ig_user_id: igUserId,
      ig_username: igUsername,
      page_id: null,
      page_access_token: longToken,
      is_active: true,
      token_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    };

    // Upsert on client_id — handles both first-connect (insert) and reconnect (update)
    // atomically. The previous update-then-insert pattern failed when Supabase RLS
    // blocked the .select() after update, causing updatedRows to be empty and triggering
    // a fallback insert that hit the ig_user_id unique constraint.
    console.log("ig_connect: upserting ig_accounts", { clientId, igUserId });
    const { error: upsertErr } = await supabase
      .from("ig_accounts")
      .upsert(
        { client_id: clientId, ...igAccountPayload },
        { onConflict: "client_id" }
      );

    console.log("ig_connect: upsert result", {
      clientId,
      igUserId,
      upsertErr: upsertErr?.message || null,
    });

    if (upsertErr) {
      console.error("ig_connect: upsert failed", { clientId, igUserId, error: upsertErr.message });
      return res.status(500).send(`Failed to save Instagram account: ${upsertErr.message}`);
    }

    // Subscribe webhook (non-blocking)
    void subscribeIgWebhook(longToken, igUserId).catch((e) =>
      console.error("ig_connect: webhook subscription threw", e?.message || e)
    );

    // Chain to Facebook OAuth to refresh page token + comment permissions.
    // The Facebook callback redirects back to /settings when complete.
    if (META_APP_ID && META_FB_REDIRECT_URI) {
      const fbState = signFbChainState({ clientId, isNew: false });
      return res.redirect(buildFacebookOAuthUrl(fbState));
    }
    return res.redirect("/settings?instagram_connected=1");
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// ── Facebook Login for Business callback ─────────────────────────────────────
// Called after the user completes the Meta business asset selection.
// Exchanges the code for a page access token and stores it alongside the
// already-stored Instagram Login token on the same ig_accounts row.
app.get("/auth/facebook/callback", async (req, res) => {
  // Determine fallback destination before touching anything
  let errorDest = "/dashboard";
  let clientId = null;
  let isNew = false;

  try {
    const stateParam = String(req.query.state || "");
    const decoded = verifyFbChainState(stateParam);
    clientId = decoded.client_id;
    isNew = !!decoded.is_new;
    errorDest = isNew ? "/coach/login.html" : "/settings";
  } catch {
    return res.redirect("/settings?facebook_error=Invalid+or+expired+state");
  }

  // Helper: redirect to final destination
  // New coaches (signup flow) → dashboard with JWT
  // Existing coaches (reconnect from settings) → settings page
  const finishRedirect = (extra = "") => {
    if (isNew) {
      const token = signCoachToken(clientId);
      return res.redirect(`/dashboard?token=${encodeURIComponent(token)}&instagram_connected=1${extra}`);
    }
    return res.redirect(`/settings?instagram_connected=1${extra}`);
  };

  const error = String(req.query.error || "");
  if (error) {
    // User cancelled or denied — Instagram token already stored, so account is usable.
    // Complete onboarding without Facebook features.
    console.warn("fb_callback: user denied Facebook OAuth", { error, clientId });
    return finishRedirect("&facebook_skipped=1");
  }

  const code = String(req.query.code || "");
  if (!code) return finishRedirect("&facebook_skipped=1");

  try {
    // Stage 1: exchange code for short-lived user token
    const shortResp = await fetch(
      `https://graph.facebook.com/v23.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(META_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(META_FB_REDIRECT_URI)}` +
      `&client_secret=${encodeURIComponent(META_APP_SECRET)}` +
      `&code=${encodeURIComponent(code)}`
    );
    const shortData = await shortResp.json().catch(() => ({}));
    if (!shortResp.ok || !shortData?.access_token) {
      console.error("fb_callback: short token exchange failed", shortData);
      return finishRedirect("&facebook_error=1");
    }

    // Stage 2: exchange for long-lived user token (~60 days)
    // Long-lived user tokens yield non-expiring page access tokens.
    const longResp = await fetch(
      `https://graph.facebook.com/v23.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(META_APP_ID)}` +
      `&client_secret=${encodeURIComponent(META_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(shortData.access_token)}`
    );
    const longData = await longResp.json().catch(() => ({}));
    const userToken = longData?.access_token || shortData.access_token;
    if (!longData?.access_token) {
      console.warn("fb_callback: long token exchange failed, using short-lived", longData);
    }

    // Stage 3: get pages list — each page includes its own long-lived access_token
    const pagesResp = await fetch(
      `https://graph.facebook.com/v23.0/me/accounts` +
      `?fields=id,name,access_token,instagram_business_account` +
      `&access_token=${encodeURIComponent(userToken)}`
    );
    const pagesData = await pagesResp.json().catch(() => ({}));
    const pages = Array.isArray(pagesData?.data) ? pagesData.data : [];

    if (!pages.length) {
      console.warn("fb_callback: no Facebook pages returned", { clientId, pagesData });
      return finishRedirect("&facebook_error=no_pages");
    }

    // Match the page whose instagram_business_account.id matches the stored ig_user_id.
    // Do NOT filter by page_id IS NULL — accounts connected via the old API also need
    // fb_page_id/fb_page_token stored, and they already have a page_id value.
    const { data: igRows } = await supabase
      .from("ig_accounts")
      .select("id, ig_user_id, page_access_token")
      .eq("client_id", clientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    const igRow = Array.isArray(igRows) ? igRows[0] : null;
    const matchedPage = igRow
      ? pages.find(p => String(p.instagram_business_account?.id) === igRow.ig_user_id)
      : null;
    const page = matchedPage || pages[0];

    // The IGBID is the instagram_business_account.id on the Facebook page object.
    // This is the authoritative ID that webhooks use for event routing.
    // igRow.ig_user_id may be the ASID (returned by /me?fields=id at connect time)
    // which differs from the IGBID — subscriptions against the ASID don't receive events.
    const igbid = String(page?.instagram_business_account?.id || "").trim() || null;
    const storedId = igRow?.ig_user_id || null;

    console.log("fb_callback: page matched", {
      clientId,
      pageId: page?.id,
      pageName: page?.name,
      matched: !!matchedPage,
      storedIgUserId: storedId,
      igbidFromPage: igbid,
      idMismatch: igbid && storedId && igbid !== storedId,
      igRowId: igRow?.id,
      hasPageToken: !!page?.access_token,
    });

    // Store fb_page_id and fb_page_token on the Instagram Login row.
    // Also correct ig_user_id to the IGBID if it was stored as the ASID.
    if (igRow?.id && page?.access_token && page?.id) {
      const dbPatch = { fb_page_id: page.id, fb_page_token: page.access_token };
      if (igbid && storedId && igbid !== storedId) {
        dbPatch.ig_user_id = igbid;
        console.log(`fb_callback: correcting ig_user_id from ASID ${storedId} to IGBID ${igbid}`);
      }

      const { error: updateErr } = await supabase
        .from("ig_accounts")
        .update(dbPatch)
        .eq("id", igRow.id);

      if (updateErr) {
        console.error("fb_callback: failed to store fb_page_id/fb_page_token", updateErr?.message);
      } else {
        console.log("fb_callback: stored fb_page_id:", page.id, "ig_user_id now:", dbPatch.ig_user_id || storedId);
      }

      // Subscribe using the IGBID (not the stored ASID). Webhooks route events by IGBID,
      // so a subscription registered against the ASID will never receive comment events.
      const subscribeId = igbid || storedId;

      // ── Subscription 1: Instagram per-account (messages) ──────────────────
      // Delivers DM events via graph.instagram.com. The Instagram endpoint returns
      // success for `comments` but does NOT deliver real comment events for
      // Instagram Business Login accounts — only the FB Page feed does.
      if (igRow?.page_access_token && subscribeId) {
        // Diagnostic: log current subscription state for both IDs if they differ
        const checkIds = igbid && storedId && igbid !== storedId
          ? [storedId, igbid]
          : [subscribeId];
        for (const checkId of checkIds) {
          fetch(
            `https://graph.instagram.com/v21.0/${encodeURIComponent(checkId)}/subscribed_apps` +
            `?access_token=${encodeURIComponent(igRow.page_access_token)}`
          )
            .then(r => r.json().catch(() => ({})))
            .then(d => console.log(`fb_callback: GET ig subscribed_apps for ${checkId}:`, JSON.stringify(d)))
            .catch(e => console.warn(`fb_callback: GET ig subscribed_apps for ${checkId} failed:`, e?.message));
        }

        void subscribeIgWebhook(igRow.page_access_token, subscribeId).then(result => {
          console.log("fb_callback: subscribeIgWebhook (messages) result", {
            subscribeId,
            ok: result.ok,
            status: result.httpStatus,
            data: result.data,
          });
        }).catch((e) =>
          console.error("fb_callback: subscribeIgWebhook threw", e?.message || e)
        );
      }

      // ── Subscription 2: Facebook Page feed (comments) ──────────────────────
      // This is the mechanism that actually delivers real Instagram post comment
      // events. The IG per-account subscription returns success for `comments`
      // but silently drops real events. The FB Page `feed` subscription delivers
      // them as field==="feed" with item==="comment" and verb==="add".
      // Requires pages_read_engagement (approved). Does NOT require pages_messaging.
      void subscribeFbPageWebhook(page.access_token, page.id).then(result => {
        console.log("fb_callback: subscribeFbPageWebhook (feed) result", {
          pageId: page.id,
          ok: result.ok,
          status: result.httpStatus,
          data: result.data,
        });
      }).catch((e) =>
        console.error("fb_callback: subscribeFbPageWebhook threw", e?.message || e)
      );
    } else {
      console.warn("fb_callback: skipping fb_page_id store — missing igRow.id, page.access_token, or page.id", {
        igRowId: igRow?.id,
        hasPageToken: !!page?.access_token,
        pageId: page?.id,
      });
    }

    return finishRedirect();
  } catch (e) {
    console.error("fb_callback: error", e?.message || e);
    return finishRedirect("&facebook_error=1");
  }
});

/**
 * ===========================
 * 24-HOUR FOLLOW-UP JOB
 * ===========================
 * Runs every 30 minutes. For each lead where:
 *   - bot sent the last message > 24h ago
 *   - the lead never replied after that message
 *   - conversation hasn't converted (no booking, no call)
 *   - follow-up hasn't already been sent
 *   - no active manual override
 * ...send one casual re-engagement DM and mark followup_sent = true.
 */

// ─── Feature 3: Missed conversation recovery on reboot ───────────────────────
// Runs once at startup. Finds leads that sent a message while the server was
// down (last_inbound_at > last_outbound_at) and sends a catch-up message so
// the conversation doesn't go cold. Uses the coach's custom follow-up message
// if one is configured (Feature 4).
async function runRebootRecoveryJob() {
  const now = Date.now();
  const min5 = new Date(now - 5 * 60 * 1000).toISOString();
  const h24  = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, ig_psid, client_id, last_inbound_at, last_outbound_at, followup_sent, manual_override, booking_sent, call_completed")
    .eq("followup_sent", false)
    .eq("manual_override", false)
    .eq("booking_sent", false)
    .eq("call_completed", false)
    .gte("last_inbound_at", h24)
    .lte("last_inbound_at", min5);

  if (error) {
    console.error("reboot_recovery: query failed", error.message);
    return;
  }

  for (const lead of leads || []) {
    const inboundMs  = lead.last_inbound_at  ? new Date(lead.last_inbound_at).getTime()  : 0;
    const outboundMs = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : -1;
    // Only recover if there's an unanswered inbound (inbound strictly newer than last outbound)
    if (inboundMs <= outboundMs) continue;

    try {
      const igAccount = await getIgAccountByClientId(lead.client_id);
      if (!igAccount?.page_access_token) continue;

      const cfg = await getClientConfig(lead.client_id).catch(() => null);
      const custom = String(cfg?.followup_message || "").trim();
      const text = custom || "hey, just picking back up from earlier — what did you want help with?";

      const { sendResp } = await sendInstagramTextMessage({
        accessToken: igAccount.page_access_token,
        recipientId: lead.ig_psid,
        text,
        useInstagramApi: !igAccount.page_id,
      });

      if (sendResp.ok) {
        await updateLeadTracking(lead.id, {
          followup_sent: true,
          last_outbound_at: nowIso(),
          last_outbound_text: text,
        });
        await supabase.from("messages").insert({
          lead_id: lead.id,
          client_id: lead.client_id,
          direction: "out",
          text,
          created_at: new Date().toISOString(),
        });
        log("reboot_recovery_dm_sent", { leadId: lead.id, clientId: lead.client_id, text });
      }
    } catch (e) {
      console.error("reboot_recovery: failed for lead", lead.id, e?.message || e);
    }
  }
}

function buildFollowUpText(leadMemory, cfg) {
  // Feature 4: use coach's custom follow-up message if set
  const custom = String(cfg?.followup_message || "").trim();
  if (custom) return custom;

  const goal = String(leadMemory?.goal || "").trim();
  const motivation = String(leadMemory?.motivation || "").trim();
  const painPoints = String(leadMemory?.pain_points || "").trim();

  if (goal) {
    return `hey, just checking in — still happy to chat if you have any questions about sorting ${goal}`;
  }
  if (painPoints) {
    return `hey, just wanted to check in — still here if you want to talk anything through`;
  }
  if (motivation) {
    return `hey, just checking in — whenever you're ready, still happy to help`;
  }
  return "hey, just checking in — still happy to help if you've got any questions!";
}

async function runFollowUpJob() {
  const H24 = 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - H24).toISOString();

  const { data: leads, error } = await supabase
    .from("leads")
    .select(
      "id, ig_psid, client_id, last_outbound_at, last_inbound_at, booking_sent, call_completed, followup_sent, manual_override"
    )
    .eq("booking_sent", false)
    .eq("call_completed", false)
    .eq("followup_sent", false)
    .eq("manual_override", false)
    .not("last_outbound_at", "is", null)
    .lt("last_outbound_at", cutoff);

  if (error) {
    console.error("followup_job: lead query failed", error.message);
    return;
  }

  for (const lead of leads || []) {
    // Skip if they replied after the bot's last message
    if (
      lead.last_inbound_at &&
      new Date(lead.last_inbound_at) > new Date(lead.last_outbound_at)
    ) {
      continue;
    }

    try {
      const igAccount = await getIgAccountByClientId(lead.client_id);
      if (!igAccount?.page_access_token) continue;

      let leadMemory = null;
      try {
        leadMemory = await getLeadMemory(lead.id);
      } catch {}

      const cfg = await getClientConfig(lead.client_id).catch(() => null);
      const text = buildFollowUpText(leadMemory, cfg).replace(/—|–|--/g, "");

      const { sendResp, sendData } = await sendInstagramTextMessage({
        accessToken: igAccount.page_access_token,
        recipientId: lead.ig_psid,
        text,
        useInstagramApi: !igAccount.page_id,
      });

      log("followup_dm_sent", {
        leadId: lead.id,
        clientId: lead.client_id,
        sendOk: sendResp.ok,
        sendData,
        text,
      });

      if (sendResp.ok) {
        await updateLeadTracking(lead.id, {
          followup_sent: true,
          last_outbound_at: nowIso(),
          last_outbound_text: text,
        });

        await supabase.from("messages").insert({
          lead_id: lead.id,
          client_id: lead.client_id,
          direction: "out",
          text,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error(
        "followup_job: failed for lead",
        lead.id,
        e?.message || e
      );
    }
  }
}

// ─── Pipeline CRM ────────────────────────────────────────────────────────────

const PIPELINE_PASSWORD   = "Looped2024!";
const PIPELINE_COOKIE_NAME = "pipeline_auth";
const PIPELINE_AUTH_TOKEN  = crypto
  .createHmac("sha256", process.env.DASHBOARD_JWT_SECRET || "pipeline_secret")
  .update(PIPELINE_PASSWORD)
  .digest("hex");

function parsePipelineCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === PIPELINE_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function isPipelineAuthed(req) {
  return parsePipelineCookie(req) === PIPELINE_AUTH_TOKEN;
}

function requirePipeline(req, res, next) {
  if (isPipelineAuthed(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// Serve login page or CRM depending on auth
app.get("/pipeline", (req, res) => {
  if (isPipelineAuthed(req)) {
    res.sendFile(path.join(__dirname, "pipeline", "pipeline.html"));
  } else {
    res.sendFile(path.join(__dirname, "pipeline", "login.html"));
  }
});

// Login
app.post("/pipeline/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== PIPELINE_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
  res.setHeader(
    "Set-Cookie",
    `${PIPELINE_COOKIE_NAME}=${PIPELINE_AUTH_TOKEN}; Path=/pipeline; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
  );
  res.json({ ok: true });
});

// GET leads
app.get("/pipeline/api/leads", requirePipeline, async (req, res) => {
  const { data, error } = await supabase
    .from("pipeline_leads")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ leads: data || [] });
});

// POST lead (create or update if handle already exists)
app.post("/pipeline/api/leads", requirePipeline, async (req, res) => {
  const {
    handle, followers, follower_count, category,
    stage, stage_reasoning, notes, next_steps,
  } = req.body || {};
  if (!handle) return res.status(400).json({ error: "handle required" });

  // Check for existing coach with same handle (case-insensitive)
  const { data: existing, error: lookupErr } = await supabase
    .from("pipeline_leads")
    .select("*")
    .ilike("handle", handle.trim())
    .maybeSingle();

  if (lookupErr) return res.status(500).json({ error: lookupErr.message });

  if (existing) {
    // Update the existing record with freshly analysed fields
    const updates = {
      stage:           stage           || existing.stage,
      stage_reasoning: stage_reasoning || existing.stage_reasoning,
      notes:           notes           || existing.notes,
      next_steps:      next_steps      || existing.next_steps,
      last_analysed_at: new Date().toISOString(),
    };
    if (followers)      updates.followers      = followers;
    if (follower_count) updates.follower_count = follower_count;
    if (category)       updates.category       = category;

    const { data: updated, error: updateErr } = await supabase
      .from("pipeline_leads")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.json({ updated: true, lead: updated });
  }

  // No existing record — insert as new
  const { data, error } = await supabase
    .from("pipeline_leads")
    .insert({
      handle:          handle.trim(),
      followers:       followers      || null,
      follower_count:  follower_count || null,
      category:        category       || null,
      stage:           stage          || "convo_cold",
      stage_reasoning: stage_reasoning || null,
      notes:           notes          || null,
      next_steps:      next_steps     || [],
      last_analysed_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: false, lead: data });
});

// PATCH lead (update)
app.patch("/pipeline/api/leads/:id", requirePipeline, async (req, res) => {
  const { id } = req.params;
  const allowed = {};
  const body = req.body || {};
  const fields = [
    "handle","followers","follower_count","category",
    "stage","stage_reasoning","notes","next_steps",
  ];
  for (const f of fields) {
    if (body[f] !== undefined) allowed[f] = body[f];
  }
  if (!Object.keys(allowed).length) return res.status(400).json({ error: "Nothing to update" });
  const { data, error } = await supabase
    .from("pipeline_leads")
    .update(allowed)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ lead: data });
});

// DELETE lead
app.delete("/pipeline/api/leads/:id", requirePipeline, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("pipeline_leads").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /pipeline/analyse — call OpenAI API with 2 images, return structured data
app.post("/pipeline/analyse", requirePipeline, async (req, res) => {
  const { profileImage, conversationImage } = req.body || {};
  if (!profileImage || !conversationImage) {
    return res.status(400).json({ error: "profileImage and conversationImage required" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const prompt = `You are analysing an Instagram coach's profile for a sales pipeline CRM.

Image 1 is the coach's Instagram profile screenshot.
Image 2 is a screenshot of the conversation or DM thread with this coach.

Extract and return ONLY a JSON object with these exact keys:
{
  "handle": "instagram username without @",
  "followers": "display string e.g. '142K'",
  "follower_count": 142000,
  "category": "niche/category e.g. 'Fitness Coach', 'Business Coach', 'Life Coach'",
  "stage": "one of: convo_cold, convo_warm, no_response, loom_created, loom_sent, interested, not_interested",
  "stage_reasoning": "1-2 sentence explanation of why this stage",
  "notes": "any other relevant notes about the coach or conversation",
  "next_steps": ["array", "of", "actionable", "next steps"]
}

IMPORTANT: Before classifying the stage, carefully inspect the conversation screenshot for the following:

1. Identify who sent the last message. Outbound messages (sent by me) appear on the RIGHT side of the screen, typically in a purple or blue bubble.

2. If the last message is outbound (from me, on the right):
   a. Look for a "Seen" timestamp directly beneath it (e.g. "Seen 18h ago", "Seen 2h ago", "Seen just now").
   b. If a "Seen" label is visible AND the time shown is greater than 1 hour ago (e.g. "Seen 2h ago", "Seen 18h ago", "Seen 3d ago"), classify as: no_response
   c. If "Seen just now" or seen within the last hour, the lead can still be classified as warm if the conversation tone warrants it.
   d. If there is NO "Seen" indicator under the last outbound message, treat it as unread or pending. Do not classify as warm unless there is a recent inbound reply visible elsewhere in the thread.

3. If the last message is inbound (from the coach, on the left), classify based on their tone and content as normal.

Stage definitions:
- convo_cold: sent a message, no reply received yet, and message has not been seen
- convo_warm: coach has replied and shown some interest or engagement
- no_response: last message was outbound, coach has seen it (more than 1 hour ago) but has not replied
- loom_created: a loom video has been created for this coach but not yet sent
- loom_sent: a loom video has been sent to this coach
- interested: coach expressed clear interest in working together
- not_interested: coach explicitly declined or is clearly uninterested

Return ONLY the JSON object, no other text.`;

  let openaiRes;
  try {
    openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:      "gpt-4o",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type:      "image_url",
                image_url: { url: profileImage },
              },
              {
                type:      "image_url",
                image_url: { url: conversationImage },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return res.status(500).json({ error: "OpenAI API request failed: " + e.message });
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => "");
    console.error("[pipeline/analyse] OpenAI error:", openaiRes.status, errText);
    return res.status(502).json({ error: "OpenAI API error: " + openaiRes.status });
  }

  const payload = await openaiRes.json();
  const text = payload?.choices?.[0]?.message?.content || "";

  // Extract JSON from response
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("[pipeline/analyse] No JSON in OpenAI response:", text);
    return res.status(502).json({ error: "Could not parse AI response" });
  }

  let result;
  try {
    result = JSON.parse(match[0]);
  } catch (e) {
    console.error("[pipeline/analyse] JSON parse error:", e.message, match[0]);
    return res.status(502).json({ error: "Could not parse AI response" });
  }

  res.json(result);
});

// ─── End Pipeline CRM ─────────────────────────────────────────────────────────

// ─── Calendly Integration ─────────────────────────────────────────────────

// Public webhook — Calendly POSTs here when a booking is created or cancelled.
// URL given to coaches: https://app.looped.ltd/webhooks/calendly/:client_id
app.post("/webhooks/calendly/:client_id", async (req, res) => {
  // Ack immediately so Calendly doesn't retry
  res.status(200).json({ ok: true });

  try {
    const { client_id } = req.params;
    const body = req.body || {};
    const eventType = body.event; // "invitee.created" | "invitee.canceled"
    const p = body.payload || {};

    if (!eventType || !p) return;

    const inviteeUri  = p.uri || null;
    const eventUri    = p.event || null;
    const inviteeName = p.name || null;
    const inviteeEmail = p.email || null;
    const se          = p.scheduled_event || {};
    const startTime   = se.start_time || null;
    const endTime     = se.end_time || null;
    const eventName   = se.name || null;

    if (eventType === "invitee.canceled") {
      await supabase
        .from("calendly_bookings")
        .update({ status: "canceled" })
        .eq("client_id", client_id)
        .eq("invitee_uri", inviteeUri);
      return;
    }

    if (eventType === "invitee.created") {
      await supabase
        .from("calendly_bookings")
        .upsert({
          client_id,
          invitee_uri:   inviteeUri,
          event_uri:     eventUri,
          invitee_name:  inviteeName,
          invitee_email: inviteeEmail,
          start_time:    startTime,
          end_time:      endTime,
          event_name:    eventName,
          status:        "active",
          raw_payload:   body,
        }, { onConflict: "invitee_uri" });
    }
  } catch (e) {
    console.error("[calendly webhook]", e?.message || e);
  }
});

// Protected — returns this coach's upcoming bookings
app.get("/coach/api/calendly/bookings", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("calendly_bookings")
      .select("id, invitee_name, invitee_email, start_time, end_time, event_name, status, created_at")
      .eq("client_id", req.coach.client_id)
      .order("start_time", { ascending: true });

    if (error) return safeJson(res, 500, { error: error.message });
    return safeJson(res, 200, { ok: true, bookings: data || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ─── Daily Planner ─────────────────────────────────────────────────────────
// Auth: password-gate only (localStorage on client). No sessions, no JWT, no DB users.
// All data stored against a fixed user_id — no FK constraint required.

const PLANNER_USER_ID = "00000000-0000-0000-0000-000000000001";

// GET /planner/day?date=YYYY-MM-DD
app.get("/planner/day", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  const { data, error } = await supabase
    .from("planner_days")
    .select("*")
    .eq("user_id", PLANNER_USER_ID)
    .eq("date", date)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.json({ exists: false });
  res.json({ exists: true, day: data });
});

// POST /planner/day — upsert a saved plan
app.post("/planner/day", async (req, res) => {
  const { date, tasks, pipeline_note, gym_time, schedule, advice } = req.body || {};
  if (!date) return res.status(400).json({ error: "date required" });

  const { error } = await supabase.from("planner_days").upsert(
    {
      user_id:       PLANNER_USER_ID,
      date,
      tasks:         tasks         || null,
      pipeline_note: pipeline_note || null,
      gym_time:      gym_time      || null,
      schedule:      schedule      || null,
      advice:        advice        || null,
      updated_at:    new Date().toISOString(),
    },
    { onConflict: "user_id,date" }
  );

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /planner/generate — call Anthropic twice and return schedule + advice
app.post("/planner/generate", async (req, res) => {
  const { tasks, pipeline_note, gym_time, date } = req.body || {};
  if (!tasks || !date) return res.status(400).json({ error: "tasks and date required" });

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const gymStr = gym_time ? gym_time.trim() : "8:30";

  const timetablePrompt = `You are a daily planner. Output a JSON array only. No prose before or after it. No markdown fences.

James fixed schedule: wake 7:00, morning routine until 8:00, breakfast 8:00-8:30, gym 1hr at ${gymStr}, work starts no earlier than 11:30, lunch ~12:30 (30min), dinner ~17:00 (30min), day ends 21:00. Add short breaks between long work blocks.

Today: ${date}
Tasks: ${tasks}

Respond with a JSON array. Each object has: time (string), title (string), detail (string), category (routine|gym|meal|work|outreach|break).
Start your response with [ and end with ]. Nothing else.`;

  // Fetch last 5 saved days, excluding today, for advisor context
  const { data: historyRows } = await supabase
    .from("planner_days")
    .select("date, tasks, pipeline_note, advice")
    .eq("user_id", PLANNER_USER_ID)
    .neq("date", date)
    .order("date", { ascending: false })
    .limit(5);

  const historyStr = (historyRows || []).length
    ? (historyRows || []).map(row => {
        const priority     = row.advice?.priority || "none recorded";
        const pipelineNote = row.pipeline_note    || "none";
        const tasksStr     = row.tasks            || "none";
        return `${row.date}: Tasks: ${tasksStr} | Pipeline update: ${pipelineNote} | Priority they were given: ${priority}`;
      }).join("\n")
    : "No previous days recorded yet.";

  const advisorPrompt = `You are a senior B2B SaaS sales and outreach advisor giving James a day by day action plan to get his first client. Output a JSON object only. No prose before or after it. No markdown fences.

James: 19yo architecture student, non-technical founder of Looped (Instagram DM automation for fitness coaches). Pitched around 10 coaches, mostly ignored. No clients yet. Loom video not filmed. Free trial offer. Testing X and Reddit outreach for coaches posting "looking for a setter" or "hiring a setter".

PREVIOUS DAYS HISTORY (most recent first):
${historyStr}

Today: ${date}
Tasks James is planning today: ${tasks}
Pipeline update today: ${pipeline_note || "No pipeline update provided."}

Using the history above, give James a sharp specific outreach plan for today that builds on what he has already done and has not done. Do not repeat advice he has already been given unless he has not acted on it. Push him forward toward his first client.

Respond with a JSON object with: priority (string), reasoning (string, reference what he did or did not do previously where relevant), actions (array of objects with title, detail, effort where effort is low or medium or high), watch_out (string). 3 to 5 actions. Direct and specific. No em dashes.
Start your response with { and end with }. Nothing else.`;

  async function callAnthropic(prompt) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:      "gpt-4o-mini",
        max_tokens: 2000,
        messages:   [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error("OpenAI error " + r.status + ": " + t.slice(0, 200));
    }
    const payload = await r.json();
    return (payload?.choices?.[0]?.message?.content || "").trim();
  }

  function parseJsonText(text, opener) {
    try { return JSON.parse(text); } catch {}
    const re = opener === "[" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    const m = text.match(re);
    if (!m) throw new Error("Could not parse AI response as JSON");
    return JSON.parse(m[0]);
  }

  try {
    const scheduleText = await callAnthropic(timetablePrompt);
    const adviceText   = await callAnthropic(advisorPrompt);
    const schedule = parseJsonText(scheduleText, "[");
    const advice   = parseJsonText(adviceText,   "{");
    res.json({ schedule, advice });
  } catch (e) {
    console.error("[planner/generate]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── End Daily Planner ───────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
// ---------------------------
// TOKEN REFRESH JOB
// ---------------------------
async function refreshExpiringTokens() {
  if (!INSTAGRAM_APP_SECRET) return; // nothing to do without the secret

  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch Instagram Login accounts with tokens expiring within 7 days
  const { data: accounts, error } = await supabase
    .from("ig_accounts")
    .select("id, ig_user_id, page_access_token, token_expires_at")
    .is("page_id", null)
    .eq("is_active", true)
    .not("token_expires_at", "is", null)
    .lt("token_expires_at", sevenDaysFromNow);

  if (error) {
    console.error("token_refresh: query failed", error.message);
    return;
  }

  if (!accounts?.length) {
    console.log("token_refresh: no tokens expiring within 7 days");
    return;
  }

  console.log(`token_refresh: refreshing ${accounts.length} token(s)`);

  for (const acc of accounts) {
    try {
      const resp = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(acc.page_access_token)}`
      );
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data?.access_token) {
        console.error("token_refresh: refresh failed", { ig_user_id: acc.ig_user_id, data });
        continue;
      }

      const expiresIn = data.expires_in || 60 * 24 * 60 * 60; // default 60 days in seconds
      const newExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();

      await supabase
        .from("ig_accounts")
        .update({ page_access_token: data.access_token, token_expires_at: newExpiry })
        .eq("id", acc.id);

      console.log("token_refresh: refreshed", { ig_user_id: acc.ig_user_id, newExpiry });
    } catch (e) {
      console.error("token_refresh: threw for account", acc.ig_user_id, e?.message || e);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH MONITOR — runs every 6 hours, alerts james@looped.ltd via Resend
// Re-alert suppression: same client+issue only re-emails after 3 days unresolved.
// ─────────────────────────────────────────────────────────────────────────────

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ALERT_EMAIL = "james@looped.ltd";
const ALERT_FROM = "Looped Alerts <alerts@looped.ltd>";
const ADMIN_BASE_URL = process.env.APP_URL || "https://app.looped.ltd";

// Re-alert suppression: for a given client+issueType, only email again if the
// issue has been unresolved for 3+ days since the last email was sent.
// Tracked via last_emailed_at on the health_issues table (DB-persisted, survives restarts).
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

async function checkAndEmailHealthIssue({ clientId, clientName, issueType, description, emailIssues, alerts_muted }) {
  // Defense-in-depth: never email for muted clients even if the outer loop check is bypassed
  if (alerts_muted) {
    console.log(`[health_monitor] MUTED guard hit inside checkAndEmailHealthIssue for ${clientName} (${clientId}) type=${issueType} — skipping email`);
    return;
  }
  try {
    // Look for an existing unresolved issue of the same type for this client
    const { data: existing } = await supabase
      .from("health_issues")
      .select("id, detected_at, last_emailed_at")
      .eq("client_id", clientId)
      .eq("issue_type", issueType)
      .eq("resolved", false)
      .order("detected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const now = new Date().toISOString();

    if (!existing) {
      // New issue — insert and email immediately
      await supabase.from("health_issues").insert({
        client_id: clientId,
        client_name: clientName || clientId,
        issue_type: issueType,
        issue_description: description,
        detected_at: now,
        last_emailed_at: now,
        resolved: false,
      });
      emailIssues.push(description);
      console.log(`[health_monitor] new issue ${issueType} for ${clientId} — emailing immediately`);
    } else {
      // Existing unresolved issue — apply re-alert suppression
      const lastEmailed = existing.last_emailed_at || existing.detected_at;
      const msSinceLastEmail = Date.now() - new Date(lastEmailed).getTime();

      if (msSinceLastEmail >= THREE_DAYS_MS) {
        // 3+ days unresolved — re-alert and update timestamp
        await supabase.from("health_issues")
          .update({ last_emailed_at: now, issue_description: description })
          .eq("id", existing.id);
        emailIssues.push(description);
        console.log(`[health_monitor] re-alert ${issueType} for ${clientId} — ${Math.floor(msSinceLastEmail / 86400000)}d since last email`);
      } else {
        console.log(`[health_monitor] suppressed ${issueType} for ${clientId} — ${Math.floor(msSinceLastEmail / 3600000)}h since last email (threshold: 72h)`);
      }
    }
  } catch (e) {
    console.warn("[health_monitor] checkAndEmailHealthIssue failed", clientId, issueType, e?.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COACH PAUSE NOTIFICATION — sends one email to the coach when a lead is paused
// and awaiting their input. Completely separate from the admin health monitor.
// Never mentions system issues or technical details.
// ─────────────────────────────────────────────────────────────────────────────

// Track which leads have already had a notification sent this session
// (secondary guard alongside the coach_notified_at DB column)
const coachNotifiedLeads = new Set();

async function sendCoachPauseNotification(leadId, clientId) {
  // In-memory guard — never spam within same process lifetime
  if (coachNotifiedLeads.has(leadId)) return;

  if (!resend) return;

  try {
    // DB guard — only send once ever per lead pause event
    const { data: lead } = await supabase
      .from("leads")
      .select("coach_notified_at, client_id")
      .eq("id", leadId)
      .single();

    if (lead?.coach_notified_at) return; // already notified

    // Get the coach's login email from coach_users
    const { data: coachUser } = await supabase
      .from("coach_users")
      .select("email")
      .eq("client_id", clientId)
      .maybeSingle();

    const coachEmail = coachUser?.email;
    if (!coachEmail) return; // no coach registered yet

    // Hard guard: never send to the admin alert email address
    if (coachEmail.toLowerCase() === ALERT_EMAIL.toLowerCase()) return;

    const dashboardUrl = `${process.env.APP_PUBLIC_URL || "https://app.looped.ltd"}/dashboard`;

    await resend.emails.send({
      from: "Looped <hello@looped.ltd>",
      to: coachEmail,
      subject: "You have a lead waiting for your reply",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <p style="font-size:16px;margin:0 0 16px;">Hey,</p>
          <p style="font-size:16px;margin:0 0 16px;">You have a lead waiting for your reply in your Looped dashboard.</p>
          <p style="margin:0 0 24px;">
            <a href="${dashboardUrl}" style="background:#2d6bff;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">View your leads</a>
          </p>
          <p style="color:#999;font-size:13px;margin:0;">Looped · <a href="${dashboardUrl}" style="color:#999;">looped.ltd</a></p>
        </div>
      `,
    });

    // Mark as notified in DB so we never send again for this pause event
    await supabase
      .from("leads")
      .update({ coach_notified_at: new Date().toISOString() })
      .eq("id", leadId);

    coachNotifiedLeads.add(leadId);
    log("coach_pause_notification_sent", { leadId, clientId, coachEmail });
  } catch (e) {
    console.warn("sendCoachPauseNotification: failed", e?.message || e);
  }
}

async function sendHealthAlert({ clientName, clientId, issues }) {
  if (!resend) {
    console.warn("health_monitor: RESEND_API_KEY not set — skipping email");
    return;
  }
  // HARD GUARD: health monitor alerts must ONLY ever go to the admin address.
  // This is enforced here unconditionally — the constant cannot be overridden.
  const HEALTH_ALERT_RECIPIENT = "james@looped.ltd";
  if (ALERT_EMAIL !== HEALTH_ALERT_RECIPIENT) {
    console.error("health_monitor: ALERT_EMAIL has been tampered — refusing to send", { ALERT_EMAIL });
    return;
  }

  const adminUrl = `${ADMIN_BASE_URL}/admin/dashboard.html`;
  const issueLines = issues.map((i) => `<li style="margin-bottom:8px;">${i}</li>`).join("");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <h2 style="color:#b42318;margin:0 0 4px;">Health alert: ${clientName}</h2>
      <p style="color:#555;margin:0 0 20px;font-size:14px;">Detected at ${new Date().toUTCString()}</p>
      <ul style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:16px 16px 16px 32px;color:#333;font-size:14px;line-height:1.6;">
        ${issueLines}
      </ul>
      <p style="margin-top:20px;">
        <a href="${adminUrl}" style="background:#2d6bff;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open admin dashboard</a>
      </p>
      <p style="color:#999;font-size:12px;margin-top:16px;">Looped health monitor · every 6 hours · re-alerts suppressed for 3 days after first detection</p>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: ALERT_FROM,
      to: ALERT_EMAIL,
      subject: `[Looped] Alert: ${clientName} — ${issues.length} issue${issues.length !== 1 ? "s" : ""} detected`,
      html,
    });
    if (result?.error) {
      console.error("health_monitor: Resend returned error", JSON.stringify(result.error));
    } else {
      log("health_alert_sent", { clientId, clientName, issueCount: issues.length, emailId: result?.data?.id });
    }
  } catch (e) {
    console.error("health_monitor: email send threw", e?.message || e);
    if (e?.response) console.error("health_monitor: Resend response body", JSON.stringify(e.response));
    if (e?.statusCode) console.error("health_monitor: Resend status code", e.statusCode);
  }
}

// recordHealthIssue replaced by checkAndEmailHealthIssue (handles insert + email suppression)

async function runHealthMonitor() {
  try {
    // 1. Fetch all clients, including mute flag
    const { data: clients, error: clientsErr } = await supabase
      .from("clients")
      .select("id, name, alerts_muted");
    if (clientsErr || !clients?.length) return;

    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const THIRTY_MINS = 30 * 60 * 1000;

    for (const client of clients) {
      const { id: clientId, name: clientName, alerts_muted } = client;

      // Log the raw mute flag value for every client so we can verify it's being read correctly
      console.log(`[health_monitor] client=${clientName} (${clientId}) alerts_muted=${JSON.stringify(alerts_muted)}`);

      // Skip muted clients entirely
      if (alerts_muted) {
        log("health_monitor_skipped_muted", { clientId, clientName });
        continue;
      }

      const emailIssues = []; // descriptions to include in this run's alert email

      // ── Check 1: Instagram token validity ─────────────────────────────────
      try {
        const igAcc = await getIgAccountByClientId(clientId);
        if (!igAcc?.page_access_token) {
          const desc = "No active Instagram token found. The account may not be connected.";
          await checkAndEmailHealthIssue({ clientId, clientName, issueType: "no_token", description: desc, emailIssues, alerts_muted });
        } else {
          const probeUrl = igAcc.page_id
            ? `https://graph.facebook.com/v21.0/${encodeURIComponent(igAcc.ig_user_id || igAcc.page_id)}?fields=id&access_token=${encodeURIComponent(igAcc.page_access_token)}`
            : `https://graph.instagram.com/v21.0/me?fields=id&access_token=${encodeURIComponent(igAcc.page_access_token)}`;

          const probe = await fetch(probeUrl).catch(() => null);
          if (probe && !probe.ok) {
            const body = await probe.json().catch(() => ({}));
            const code = body?.error?.code;
            if (code === 190 || code === 102 || probe.status === 401) {
              const desc = `Instagram token is invalid or expired (error code ${code ?? probe.status}). Re-connect Instagram in the coach dashboard.`;
              await checkAndEmailHealthIssue({ clientId, clientName, issueType: "invalid_token", description: desc, emailIssues, alerts_muted });
            }
          }
        }
      } catch (e) {
        console.warn("health_monitor: token check failed for", clientId, e?.message);
      }

      // ── Check 2: Leads stuck in manual_override > 2 hours ────────────────
      try {
        const cutoff = new Date(now - TWO_HOURS).toISOString();
        const { data: stuckLeads, error: stuckErr } = await supabase
          .from("leads")
          .select("id, ig_name, ig_psid, manual_override_at, manual_override_reason")
          .eq("client_id", clientId)
          .eq("manual_override", true)
          .lt("manual_override_at", cutoff);

        if (!stuckErr && stuckLeads?.length > 0) {
          const names = stuckLeads.map((l) =>
            l.ig_name || `···${String(l.ig_psid || "").slice(-6)}`
          ).join(", ");
          const desc = `${stuckLeads.length} lead${stuckLeads.length !== 1 ? "s" : ""} stuck with bot paused for over 2 hours: ${names}`;
          await checkAndEmailHealthIssue({ clientId, clientName, issueType: "stuck_leads", description: desc, emailIssues, alerts_muted });
        }
      } catch (e) {
        console.warn("health_monitor: stuck leads check failed for", clientId, e?.message);
      }

      // ── Check 3: Recent webhook_async_errors ──────────────────────────────
      try {
        const errors = recentWebhookErrors.get(clientId) || [];
        const recent = errors.filter((e) => now - e.ts.getTime() < THIRTY_MINS);
        if (recent.length >= 3) {
          const desc = `${recent.length} webhook errors in the last 30 minutes. Latest: "${recent[recent.length - 1].error.slice(0, 120)}"`;
          await checkAndEmailHealthIssue({ clientId, clientName, issueType: "webhook_errors", description: desc, emailIssues, alerts_muted });
        }
      } catch (e) {
        console.warn("health_monitor: webhook error check failed for", clientId, e?.message);
      }

      // ── Send alert email if any issues need emailing this run ─────────────
      if (emailIssues.length > 0) {
        console.log(`[health_monitor] sending email for ${clientName} (${clientId}) alerts_muted=${JSON.stringify(alerts_muted)} issues=${emailIssues.length}`);
        await sendHealthAlert({ clientName: clientName || clientId, clientId, issues: emailIssues });
      }
    }
  } catch (e) {
    console.error("health_monitor: run failed", e?.message || e);
  }
}

// ── Nightly client deletion job ───────────────────────────────────────────────
async function runClientDeletionJob() {
  const now = new Date().toISOString();
  const { data: dueClients, error } = await supabase
    .from("clients")
    .select("id, name")
    .eq("is_active", false)
    .not("scheduled_deletion_at", "is", null)
    .lte("scheduled_deletion_at", now);

  if (error) {
    console.error("client_deletion_job: fetch failed", error.message);
    return;
  }
  if (!dueClients || dueClients.length === 0) {
    log("client_deletion_job: no clients due for deletion");
    return;
  }

  for (const client of dueClients) {
    const clientId = client.id;
    try {
      // Delete in dependency order: leads → ig_accounts → client_configs → clients
      const { error: leadsErr } = await supabase.from("leads").delete().eq("client_id", clientId);
      if (leadsErr) throw new Error(`leads delete failed: ${leadsErr.message}`);

      const { error: igErr } = await supabase.from("ig_accounts").delete().eq("client_id", clientId);
      if (igErr) throw new Error(`ig_accounts delete failed: ${igErr.message}`);

      const { error: cfgErr } = await supabase.from("client_configs").delete().eq("client_id", clientId);
      if (cfgErr) throw new Error(`client_configs delete failed: ${cfgErr.message}`);

      const { error: clientErr } = await supabase.from("clients").delete().eq("id", clientId);
      if (clientErr) throw new Error(`clients delete failed: ${clientErr.message}`);

      log("client_deletion_job: deleted client", { clientId, clientName: client.name });
    } catch (e) {
      console.error("client_deletion_job: deletion failed for", clientId, e?.message || e);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT POLL JOB
// Temporary solution while pages_manage_metadata is pending App Review.
// Polls Instagram Graph API every 60 seconds for new comments on recent media,
// then routes matching comments through the existing keyword/auto-DM handlers.
//
// Uses instagram_manage_comments (already approved).
// Only runs for accounts where comment features are enabled.
// Tracks last_comment_polled_at per ig_account to avoid re-processing comments.
// ─────────────────────────────────────────────────────────────────────────────

async function runCommentPollJob() {
  // Load all active IG accounts that have a token and ig_user_id
  const { data: accounts, error: accErr } = await supabase
    .from("ig_accounts")
    .select("id, client_id, ig_user_id, ig_username, page_access_token, last_comment_polled_at")
    .eq("is_active", true)
    .not("page_access_token", "is", null)
    .not("ig_user_id", "is", null);

  if (accErr) {
    console.error("[comment_poll] failed to load ig_accounts:", accErr.message);
    return;
  }
  if (!accounts?.length) return;

  for (const acc of accounts) {
    try {
      // Only poll if at least one comment feature is enabled for this client
      const { data: cfg } = await supabase
        .from("client_configs")
        .select("comment_keyword_dm_enabled, comment_reply_auto_dm_enabled")
        .eq("client_id", acc.client_id)
        .maybeSingle();

      if (!cfg?.comment_keyword_dm_enabled && !cfg?.comment_reply_auto_dm_enabled) continue;

      await pollAccountComments(acc);
    } catch (e) {
      console.error(`[comment_poll] error for account ${acc.ig_username || acc.ig_user_id}:`, e?.message || e);
    }
  }
}

async function pollAccountComments(acc) {
  const token = acc.page_access_token;
  const igUserId = acc.ig_user_id;

  // Determine the cutoff time for "new" comments.
  // First poll: look back 24 hours. Subsequent polls: use last_comment_polled_at.
  const cutoff = acc.last_comment_polled_at
    ? new Date(acc.last_comment_polled_at)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);

  // Update last_comment_polled_at immediately so concurrent runs don't overlap.
  // Use the start of this poll as the new watermark.
  const pollStartIso = new Date().toISOString();
  await supabase
    .from("ig_accounts")
    .update({ last_comment_polled_at: pollStartIso })
    .eq("id", acc.id);

  // Fetch up to 10 most recent media items
  const mediaResp = await fetch(
    `https://graph.instagram.com/v21.0/${encodeURIComponent(igUserId)}/media` +
    `?fields=id,timestamp&limit=10&access_token=${encodeURIComponent(token)}`
  );
  const mediaData = await mediaResp.json().catch(() => ({}));

  if (!mediaResp.ok || !Array.isArray(mediaData?.data)) {
    console.warn(`[comment_poll] media fetch failed for ${igUserId}:`, mediaData?.error?.message || mediaResp.status);
    return;
  }

  // Only check posts from the last 7 days to avoid hammering old posts
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentMedia = mediaData.data.filter(
    (m) => m.timestamp && new Date(m.timestamp) >= sevenDaysAgo
  );

  console.log(`[comment_poll] ${acc.ig_username || igUserId}: ${mediaData.data.length} total posts, ${recentMedia.length} within 7 days`);
  console.log(`[comment_poll] cutoff=${cutoff.toISOString()} cutoffUnix=${cutoffUnix} (since param sent to API)`);

  if (!recentMedia.length) {
    console.log(`[comment_poll] ${acc.ig_username || igUserId}: no posts within 7 days — skipping`);
    return;
  }

  let newCommentsFound = 0;

  for (const media of recentMedia) {
    // Fetch comments WITHOUT the since param first so we can see all comments,
    // then filter client-side. This lets us log what the API actually returns
    // vs what gets filtered out by the cutoff check.
    // Request nested from{id,username} explicitly — the plain `from` field returns
    // the object but Meta may omit id/username without the nested selector.
    const commentsUrl =
      `https://graph.instagram.com/v21.0/${encodeURIComponent(media.id)}/comments` +
      `?fields=id,text,timestamp,from{id,username}&limit=50` +
      `&access_token=${encodeURIComponent(token)}`;

    const commentsResp = await fetch(commentsUrl);
    const commentsData = await commentsResp.json().catch(() => ({}));

    if (!commentsResp.ok) {
      console.warn(`[comment_poll] comments fetch failed for media ${media.id}:`, JSON.stringify(commentsData?.error || commentsResp.status));
      continue;
    }

    const allComments = Array.isArray(commentsData?.data) ? commentsData.data : [];

    // Log raw API result so we can see if comments exist at all and what fields come back
    console.log(`[comment_poll] media ${media.id} (${media.timestamp}): ${allComments.length} total comment(s) from API`);
    if (allComments.length > 0) {
      console.log(`[comment_poll] raw comments:`, JSON.stringify(allComments.map(c => ({
        id: c.id,
        timestamp: c.timestamp,
        text: String(c.text || "").slice(0, 60),
        fromId: c.from?.id || null,
        fromUsername: c.from?.username || c.username || null,
      }))));
    }

    for (const comment of allComments) {
      const commentTimestamp = comment.timestamp ? new Date(comment.timestamp) : null;

      // Log cutoff comparison for each comment so we can see which are filtered
      const afterCutoff = commentTimestamp ? commentTimestamp > cutoff : null;
      console.log(`[comment_poll] comment ${comment.id}: ts=${comment.timestamp} afterCutoff=${afterCutoff} (cutoff=${cutoff.toISOString()})`);

      if (commentTimestamp && commentTimestamp <= cutoff) {
        console.log(`[comment_poll] comment ${comment.id}: SKIPPED — older than cutoff`);
        continue;
      }

      const commentId = String(comment.id || "");
      const commenterId = String(comment.from?.id || "");
      const commenterUsername = comment.from?.username || null;
      const commentText = String(comment.text || "").trim();

      // Must have a comment ID and text to do anything useful
      if (!commentId || !commentText) {
        console.log(`[comment_poll] comment ${comment.id}: SKIPPED — missing id or text`, { hasId: !!commentId, hasText: !!commentText });
        continue;
      }

      // Skip own comments (account owner commenting on their own post)
      if (commenterId && commenterId === igUserId) {
        console.log(`[comment_poll] comment ${comment.id}: SKIPPED — own comment`);
        continue;
      }

      newCommentsFound++;
      console.log(`[comment_poll] DISPATCHING comment ${commentId}:`, {
        mediaId: media.id,
        commenterId: commenterId || "(no from.id)",
        commenterUsername,
        text: commentText.slice(0, 80),
      });

      // handlePostCommentKeyword sends a DM — requires commenterId (from.id).
      // handlePostCommentAutoDm also sends a DM — same requirement.
      // Public comment replies inside both handlers only need commentId, so
      // both handlers are always called; each skips the DM step internally
      // if commenterId is empty (the DM send will simply fail gracefully).
      if (commenterId) {
        void handlePostCommentKeyword(igUserId, commentId, commenterId, commenterUsername, commentText);
        void handlePostCommentAutoDm(igUserId, commentId, commenterId, commenterUsername, commentText);
      } else {
        // No from.id — can't send a DM, but public reply doesn't need it.
        // Call handlers with a placeholder; they will skip the DM and attempt the reply.
        console.log(`[comment_poll] comment ${commentId}: no from.id — skipping DM, attempting public reply only`);
        void handlePostCommentKeyword(igUserId, commentId, "", commenterUsername, commentText);
        void handlePostCommentAutoDm(igUserId, commentId, "", commenterUsername, commentText);
      }
    }
  }

  console.log(`[comment_poll] ${acc.ig_username || igUserId}: poll complete — ${newCommentsFound} new comment(s) dispatched`);
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Diagnostic: log subscribed_apps for every active IG account so we can confirm
  // which fields (messages, comments) are registered and against which ID (IGBID vs ASID).
  setTimeout(async () => {
    try {
      const { data: accounts } = await supabase
        .from("ig_accounts")
        .select("id, ig_user_id, ig_username, page_access_token")
        .eq("is_active", true);

      if (!Array.isArray(accounts) || !accounts.length) {
        console.log("[startup:subscribed_apps] no active ig_accounts found");
        return;
      }

      for (const acc of accounts) {
        if (!acc.page_access_token || !acc.ig_user_id) continue;
        try {
          const r = await fetch(
            `https://graph.instagram.com/v21.0/${encodeURIComponent(acc.ig_user_id)}/subscribed_apps` +
            `?access_token=${encodeURIComponent(acc.page_access_token)}`
          );
          const d = await r.json().catch(() => ({}));
          console.log(`[startup:subscribed_apps] ig_user_id=${acc.ig_user_id} username=${acc.ig_username || "?"}:`, JSON.stringify(d));
        } catch (e) {
          console.warn(`[startup:subscribed_apps] fetch failed for ${acc.ig_user_id}:`, e?.message);
        }
      }
    } catch (e) {
      console.error("[startup:subscribed_apps] query failed:", e?.message);
    }
  }, 10 * 1000);

  // Feature 3: Missed conversation recovery — runs once 30s after startup
  setTimeout(() => {
    runRebootRecoveryJob().catch((e) =>
      console.error("reboot_recovery: startup run failed", e?.message || e)
    );
  }, 30 * 1000);

  // Run once on startup (after 2 min to let the server settle)
  setTimeout(() => {
    runFollowUpJob().catch((e) =>
      console.error("followup_job: startup run failed", e?.message || e)
    );
  }, 2 * 60 * 1000);

  // Then run every 30 minutes
  setInterval(() => {
    runFollowUpJob().catch((e) =>
      console.error("followup_job: interval run failed", e?.message || e)
    );
  }, 30 * 60 * 1000);

  // Feature 4: DM Safety Queue — flush any pending items immediately on startup,
  // then continue processing every 30 seconds as a safety net
  processDmQueue().catch((e) =>
    console.error("dm_queue: startup flush failed", e?.message || e)
  );
  setInterval(() => {
    processDmQueue().catch((e) =>
      console.error("dm_queue: processor error", e?.message || e)
    );
  }, 30 * 1000);

  // Token refresh job — runs every 12 hours, refreshes tokens expiring within 7 days
  setInterval(() => {
    refreshExpiringTokens().catch((e) =>
      console.error("token_refresh: error", e?.message || e)
    );
  }, 12 * 60 * 60 * 1000);

  // Health monitor — first run 2 min after startup, then every 6 hours
  setTimeout(() => {
    runHealthMonitor().catch((e) => console.error("health_monitor: startup run failed", e?.message || e));
    setInterval(() => {
      runHealthMonitor().catch((e) => console.error("health_monitor: error", e?.message || e));
    }, 6 * 60 * 60 * 1000);
  }, 2 * 60 * 1000);

  // Client deletion job — runs once daily at startup check, then every 24 hours
  setTimeout(() => {
    runClientDeletionJob().catch((e) => console.error("client_deletion_job: startup run failed", e?.message || e));
  }, 5 * 60 * 1000);
  setInterval(() => {
    runClientDeletionJob().catch((e) => console.error("client_deletion_job: error", e?.message || e));
  }, 24 * 60 * 60 * 1000);

  // Comment poll job — temporary fallback while pages_manage_metadata is pending
  // App Review. Polls Instagram Graph API every 60s for new comments on recent
  // posts for any client with comment_keyword_dm_enabled or comment_reply_auto_dm_enabled.
  // First run after 30s (let server settle); then every 60s.
  setTimeout(() => {
    runCommentPollJob().catch((e) => console.error("[comment_poll] startup run failed:", e?.message || e));
    setInterval(() => {
      runCommentPollJob().catch((e) => console.error("[comment_poll] error:", e?.message || e));
    }, 60 * 1000);
  }, 30 * 1000);
});

// ── ADDITIVE: Self-serve trial flow ──────────────────────────────────────────
// All logic lives in trial/routes.js — this is the only change to this file.
// Routes added: GET /trial/admin, GET /start/:token, POST /api/trial/checkout/:token,
//               GET /trial/success, GET+POST /admin/api/trial/*
// Remove this block to disable the trial flow entirely.
import("./trial/routes.js")
  .then(({ default: trialRouter }) => {
    app.use(trialRouter);
    console.log("[trial] routes mounted");
  })
  .catch((e) => console.error("[trial] failed to mount routes:", e?.message || e));

