import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import jwt from "jsonwebtoken";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import { supabase } from "./supabaseClient.js";

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

// Privacy + Terms pages
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
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
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
  return res.sendFile(path.join(__dirname, "coach", "login.html"));
});

app.get("/dashboard", (req, res) => {
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
  return res.sendFile(path.join(__dirname, "coach", "dashboard.html"));
});

app.get("/stats", (req, res) => {
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
  return res.sendFile(path.join(__dirname, "coach", "stats.html"));
});

app.get("/settings", (req, res) => {
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
  return res.sendFile(path.join(__dirname, "coach", "settings.html"));
});

app.get("/leads-page", (req, res) => {
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
  return res.sendFile(path.join(__dirname, "coach", "leads-page.html"));
});

app.get("/set-password", (req, res) => {
  if (!isAppHost(req) && process.env.NODE_ENV === "production") {
    return res.status(404).send("Not Found");
  }
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
function log(event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    })
  );
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
  return s === "active" || s === "trialing";
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

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field === "comments" && change?.value) {
        const v = change.value;
        // v.from.id is the commenter, v.id is the comment id, v.message is the comment text
        if (v?.from?.id && v?.id && v?.message) {
          commentEvents.push({
            igAccountId: entry.id,
            commentId: String(v.id),
            commenterId: String(v.from.id),
            commentText: String(v.message),
          });
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
function normaliseTriggerText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}

function parseKeywordFromPhrase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // If coach types: dm me "START"
  const quoted = raw.match(/["']([^"']+)["']/);
  if (quoted?.[1]) {
    return normaliseTriggerText(quoted[1]);
  }

  // fallback: use whole field
  return normaliseTriggerText(raw);
}

function isStoryReplyTrigger(messaging) {
  // Meta payloads can vary depending on the exact entry point.
  // This is defensive so you can log and tighten later if needed.
  return !!(
    messaging?.message?.reply_to?.story ||
    messaging?.message?.reply_to?.mid ||
    messaging?.postback?.referral?.source === "story_mention" ||
    messaging?.referral?.source === "story_mention" ||
    messaging?.message?.is_story_reply === true
  );
}

function isPlainTextMessage(messaging) {
  return !!String(messaging?.message?.text || "").trim();
}

function shouldUseStoryAutoDm(cfg, messaging) {
  return !!(
    cfg?.story_reply_auto_dm_enabled &&
    String(cfg?.story_reply_auto_dm_text || "").trim() &&
    isStoryReplyTrigger(messaging)
  );
}

function shouldUseKeywordAutoDm(cfg, text) {
  if (!cfg?.keyword_auto_dm_enabled) return false;

  const trigger = parseKeywordFromPhrase(cfg?.keyword_trigger_text);
  if (!trigger) return false;

  const incoming = normaliseTriggerText(text);
  if (!incoming) return false;

  return incoming === trigger;
}

function getStoryAutoDmText(cfg) {
  return String(cfg?.story_reply_auto_dm_text || "").trim();
}

function getKeywordAutoDmText(cfg) {
  return String(cfg?.keyword_auto_dm_text || "").trim();
}
function isCommentReplyTrigger(messaging) {
  const referralSource = String(
    messaging?.referral?.source ||
    messaging?.postback?.referral?.source ||
    ""
  ).toLowerCase();

  const referralType = String(
    messaging?.referral?.type ||
    messaging?.postback?.referral?.type ||
    ""
  ).toLowerCase();

  const replyTo = messaging?.message?.reply_to || null;

  return !!(
    messaging?.message?.is_comment_reply === true ||
    replyTo?.comment_id ||
    referralSource === "comments" ||
    referralSource === "post" ||
    referralType === "comment_mention"
  );
}

function shouldUseCommentAutoDm(cfg, messaging) {
  return !!(
    cfg?.comment_reply_auto_dm_enabled &&
    String(cfg?.comment_reply_auto_dm_text || "").trim() &&
    isCommentReplyTrigger(messaging)
  );
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

  return parsed;
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
function getEffectiveNiche(cfg) {
  const niche = String(cfg?.niche || "").trim().toLowerCase();

  if (["fitness", "money", "generic"].includes(niche)) {
    return niche;
  }

  return "generic";
}

function getNicheLabel(niche) {
  if (niche === "fitness") return "fitness coaching";
  if (niche === "money") return "money/business coaching";
  return "general coaching";
}

function getNichePreset(niche) {
  if (niche === "fitness") {
    return {
      whatYouDo:
        "I help people get in shape properly with structure, accountability, and a plan they actually stick to.",
      whatTheyGet:
        "You get proper structure, accountability, clear targets, and support so you actually follow through instead of falling off after a week.",
      howItWorks:
        "You get started, we look at where you're at now, what needs fixing, then everything gets built around that so you've got a clear plan and proper support.",
      whoItsFor:
        "It’s for people who are serious about getting in shape and want real structure, not people looking for a quick fix or random motivation.",
    };
  }

  if (niche === "money") {
    return {
      whatYouDo:
        "I help people tighten their offer, fix their messaging, and get more consistent clients instead of guessing and hoping.",
      whatTheyGet:
        "You get clarity on the offer, better positioning, direct support, and a proper path to getting clients more consistently.",
      howItWorks:
        "We look at where you're at, what’s not converting, what needs tightening up, then build a clearer path so you can actually move properly.",
      whoItsFor:
        "It’s for people who want to make more money, get more clients, and stop drifting with no real structure.",
    };
  }

  return {
    whatYouDo:
      "I help people get a proper result with a clear plan, the right support, and a process that actually helps them follow through.",
    whatTheyGet:
      "You get proper support, structure, and guidance so you can stop guessing and actually move properly.",
    howItWorks:
      "We look at where you're at, what needs fixing, and the best next steps so everything is clear and moving in the right direction.",
    whoItsFor:
      "It’s for people who want proper help and structure, not people just winging it.",
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
}) {
  const payload = {
    recipient: { id: recipientId },
    message: { text: String(text || "").trim() },
  };

  return sendWithRetry(async () => {
    const sendResp = await fetch(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(accessToken)}`,
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
      cfg?.offer_price
        ? `it’s ${cfg.offer_price}`
        : `i can break the pricing down properly for you`,
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
  const offerPrice = String(cfg?.offer_price || "").trim();
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
}) {
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
  if (lead?.call_completed) return "post_call";

  if (turnStrategy?.type === "send_booking_link_now") return "booking_pushed";
  if (turnStrategy?.type === "soft_close_to_booking") return "booking_pushed";
  if (turnStrategy?.type === "handle_price_then_cta") return "objection_pending";
  if (turnStrategy?.type === "handle_think_about_it") return "objection_pending";

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
    return "qualified";
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

  const exampleMessages = examplesToUse.flatMap((ex) => [
    { role: "user", content: ex.user },
    { role: "assistant", content: ex.assistant },
  ]);

  const systemPrompt = `
You are a real person replying to Instagram DMs on behalf of a coach.
You are warm, direct, and genuinely interested in the person you’re talking to.

VOICE PRIORITY:
1. match the example messages first
2. then follow the coach tone/style/vocabulary
3. if they conflict, example messages win

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
- if niche is fitness, sound natural for fitness and body transformation conversations
- if niche is money, sound natural for client acquisition, business growth, and sales
- do not mix the two

Return ONLY valid JSON in this exact shape:
{
  "reply": "string",
  "reply_type": "answer|answer_then_nudge|question|close|objection",
  "should_send_booking_link": false
}
  `.trim();
const coachSystemPrompt = String(cfg?.system_prompt || "").trim();

const finalSystemPrompt =
  coachSystemPrompt.length >= 120
    ? `${systemPrompt}

COACH-SPECIFIC INSTRUCTIONS:
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

  offer_price: cfg?.offer_price || null,
  offer_description: cfg?.offer_description || null,
  what_you_do: getEffectiveWhatYouDo(cfg),
  what_they_get: structuredOffer.what_they_get || null,
  who_its_for: structuredOffer.who_its_for || null,
  how_it_works: structuredOffer.how_it_works || null,

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

    return {
      reply,
      reply_type: String(parsed?.reply_type || "answer"),
      should_send_booking_link: !!parsed?.should_send_booking_link,
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
  };

  let q = supabase.from("leads").update(patch).eq("id", leadId);
  if (clientId) q = q.eq("client_id", clientId);

  const { data, error } = await q.select("*").single();
  if (error) throw error;
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

async function lookupIgName(accessToken, igPsid) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(igPsid)}?fields=name&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await resp.json().catch(() => ({}));
    return data?.name || null;
  } catch {
    return null;
  }
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
    .single();

  if (error) throw error;
  return data;
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
  if (!decoded || decoded.type !== "instagram_connect" || !decoded.client_id) {
    throw new Error("invalid state");
  }
  return decoded;
}

app.get("/coach/api/instagram/connect-url", requireCoach, async (req, res) => {
  try {
    if (!META_APP_ID || !META_REDIRECT_URI || !META_CONFIG_ID) {
      return safeJson(res, 500, { error: "Meta env vars not configured" });
    }

    const state = signInstagramState(req.coach.client_id);

    const authUrl = new URL("https://www.facebook.com/v23.0/dialog/oauth");
    authUrl.searchParams.set("client_id", META_APP_ID);
    authUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("config_id", META_CONFIG_ID);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("auth_type", "rerequest");

    return safeJson(res, 200, {
      ok: true,
      url: authUrl.toString(),
    });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});
app.get("/coach/api/instagram/status", requireCoach, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ig_accounts")
      .select("ig_user_id, ig_username, page_id, is_active")
      .eq("client_id", req.coach.client_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return safeJson(res, 200, {
        connected: false,
      });
    }

    return safeJson(res, 200, {
      connected: true,
      username: data.ig_username || null,
      ig_user_id: data.ig_user_id || null,
      page_id: data.page_id || null,
    });
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
    .single();

  if (error) throw error;
  return data;
}

/**
 * ===========================
 * ADMIN AUTH
 * ===========================
 */

function signAdminToken() {
  if (!DASHBOARD_JWT_SECRET) return null;
  return jwt.sign({ role: "admin" }, DASHBOARD_JWT_SECRET, {
    expiresIn: "7d",
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
  } catch {
    return safeJson(res, 401, { error: "invalid token" });
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
    const { name, email, timezone } = req.body || {};

    const clientName = String(name || "").trim();
    const coachEmail = String(email || "").trim().toLowerCase();
    const clientTimezone = String(timezone || "").trim() || "Europe/London";

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
    system_prompt: null,
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
    const clientId = req.params.clientId;
    const { email } = req.body || {};

    if (!clientId) {
      return safeJson(res, 400, { error: "clientId required" });
    }

    const token = crypto.randomBytes(24).toString("hex");

    const { error } = await supabase
      .from("payment_links")
      .insert({
        token,
        client_id: clientId,
        email: email || null,
      });

    if (error) {
      return safeJson(res, 500, error);
    }

const url = `${PAY_PUBLIC_URL}/checkout?token=${token}`;

    return safeJson(res, 200, {
      ok: true,
      url,
      token,
    });
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
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

    if (!token) return safeJson(res, 401, { error: "missing token" });

    const decoded = jwt.verify(token, COACH_JWT_SECRET);

    if (!decoded || decoded.role !== "coach" || !decoded.client_id) {
      return safeJson(res, 403, { error: "forbidden" });
    }

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
  } catch {
    return safeJson(res, 401, { error: "invalid token" });
  }
}

/**
 * ===========================
 * COACH PASSWORD SETUP
 * ===========================
 */

app.post("/coach/api/set-password", async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return safeJson(res, 400, { error: "token and password required" });
    }

    if (String(password).length < 8) {
      return safeJson(res, 400, {
        error: "password must be at least 8 characters",
      });
    }

    const { data: link, error: linkErr } = await supabase
      .from("payment_links")
      .select("*")
      .eq("token", token)
      .single();

    if (linkErr || !link) {
      return safeJson(res, 400, { error: "invalid setup token" });
    }

    if (!link.email || !link.client_id) {
      return safeJson(res, 400, {
        error: "payment link is missing email or client_id",
      });
    }

    const password_hash = await bcrypt.hash(String(password), 10);

    const { data: existingUsers, error: existingUsersErr } = await supabase
      .from("coach_users")
      .select("*")
      .eq("email", String(link.email).toLowerCase())
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
          email: String(link.email).toLowerCase(),
          password_hash,
          client_id: link.client_id,
        });

      if (insertErr) {
        return safeJson(res, 500, { error: String(insertErr.message || insertErr) });
      }
    }

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
    const { data, error } = await supabase
      .from("client_configs")
      .select("*")
      .eq("client_id", req.coach.client_id)
      .single();

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, config: data });
  } catch (e) {
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
// New follower auto-DM
if (typeof patch.new_follower_dm_text === "string" || patch.new_follower_dm_text === null) {
  allowed.new_follower_dm_text = patch.new_follower_dm_text;
}
// Feature 2 — contact collection
if (typeof patch.contact_collection_enabled === "boolean") {
  allowed.contact_collection_enabled = patch.contact_collection_enabled;
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
    const { data, error } = await supabase
      .from("client_configs")
      .update(allowed)
      .eq("client_id", req.coach.client_id)
      .select()
      .single();

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, config: data });
  } catch (e) {
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

app.get("/coach/api/leads", requireCoach, async (req, res) => {
  try {
    const { data: leads, error } = await supabase
      .from("leads")
      .select(
        "id,created_at,ig_psid,ig_name,stage,booking_sent,call_completed,manual_override,manual_override_reason,manual_override_by,manual_override_at,last_inbound_at,last_outbound_at,email,phone,followup_sent"
      )
      .eq("client_id", req.coach.client_id)
      .order("last_inbound_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, leads: leads || [] });
  } catch (e) {
    return safeJson(res, 500, { error: String(e?.message || e) });
  }
});

// ── Debug: return what client_id the JWT has vs ig_accounts ──────────────
app.get("/coach/api/instagram/debug", requireCoach, async (req, res) => {
  try {
    const clientId = req.coach.client_id;

    const { data: igRows } = await supabase
      .from("ig_accounts")
      .select("id, client_id, ig_username, is_active, created_at")
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
- If niche is fitness, the assistant should naturally sound like someone who sells fitness coaching
- If niche is money, the assistant should naturally sound like someone who sells business / money / client acquisition help
- Do not mix niches
- Do not sound generic if niche context exists

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

    if (!leadIds.length) {
      return safeJson(res, 200, {
        ok: true,
        totals: {
          leads: 0,
          conversations: 0,
          repliesSent: 0,
          replyRate: 0,
          bookingClicks: 0,
        },
      });
    }

    const { data: msgs, error: msgErr } = await supabase
      .from("messages")
      .select("lead_id,direction")
      .in("lead_id", leadIds)
      .limit(10000);

    if (msgErr) return safeJson(res, 500, msgErr);

    let repliesSent = 0;
    const convoSet = new Set();

    for (const m of msgs || []) {
      if (m?.direction === "out") repliesSent++;
      if (m?.direction === "in" && m?.lead_id) convoSet.add(m.lead_id);
    }

    const conversations = convoSet.size;

    let replyRate = 0;
    if (conversations > 0) {
      replyRate = Math.round((repliesSent / conversations) * 100);
      if (replyRate > 100) replyRate = 100;
      if (replyRate < 0) replyRate = 0;
    }

    const bookingClicks = 0;

    return safeJson(res, 200, {
      ok: true,
      totals: {
        leads: leadsCount,
        conversations,
        repliesSent,
        replyRate,
        bookingClicks,
      },
    });
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
    `https://graph.facebook.com/v19.0/${encodeURIComponent(commentId)}/replies?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: replyText }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

async function handlePostCommentKeyword(igAccountId, commentId, commenterId, commentText) {
  try {
    const { data: igAccount, error: igLookupError } = await supabase
      .from("ig_accounts")
      .select("client_id, ig_user_id, page_id, page_access_token")
      .eq("is_active", true)
      .or(`page_id.eq.${igAccountId},ig_user_id.eq.${igAccountId}`)
      .maybeSingle();

    if (igLookupError || !igAccount?.page_access_token) {
      console.error("comment_keyword: no active IG account found", {
        igAccountId,
        error: igLookupError?.message || null,
      });
      return;
    }

    const { data: cfg } = await supabase
      .from("client_configs")
      .select("comment_keyword_dm_enabled, comment_keyword_trigger, comment_keyword_dm_text, comment_keyword_reply_enabled, comment_keyword_reply_text")
      .eq("client_id", igAccount.client_id)
      .maybeSingle();

    if (!cfg?.comment_keyword_dm_enabled) return;

    const trigger = normaliseTriggerText(cfg.comment_keyword_trigger || "");
    if (!trigger) return;

    const incoming = normaliseTriggerText(commentText);
    // Match if comment contains the keyword (more permissive than exact match for comments)
    if (!incoming.includes(trigger)) return;

    const dmText = String(cfg.comment_keyword_dm_text || "").trim();
    if (!dmText) return;

    // Send DM to commenter
    const { sendResp, sendData } = await sendInstagramTextMessage({
      accessToken: igAccount.page_access_token,
      recipientId: commenterId,
      text: dmText,
    });

    log("ig_comment_keyword_dm_sent", {
      igAccountId,
      commentId,
      commenterId,
      clientId: igAccount.client_id,
      sendOk: sendResp.ok,
      sendData,
    });

    // Optionally post a public reply to the comment
    if (cfg.comment_keyword_reply_enabled) {
      const replyText = String(cfg.comment_keyword_reply_text || "").trim();
      if (replyText) {
        const { ok: replyOk, data: replyData } = await postPublicCommentReply(
          igAccount.page_access_token,
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

/**
 * ===========================
 * FEATURE 4: DM SAFETY QUEUE
 * ===========================
 */

// Rate tracker: { igAccountId: { count: N, windowStart: Date } }
const dmQueueRateTracker = new Map();
const DM_QUEUE_MAX_PER_HOUR = 200;

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

async function processDmQueue() {
  try {
    // Fetch pending messages ordered by created_at (oldest first), limit batch
    const { data: pendingItems, error } = await supabase
      .from("dm_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      console.error("processDmQueue fetch failed:", error);
      return;
    }
    if (!pendingItems || pendingItems.length === 0) return;

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
          await supabase.from("dm_queue").update({
            status: "failed",
            error: "No access token",
            processed_at: new Date().toISOString(),
          }).eq("id", item.id);
          continue;
        }

        // Send the message
        const { sendResp } = await sendInstagramTextMessage({
          accessToken: igAccount.page_access_token,
          recipientId: item.ig_psid,
          text: item.message,
        });

        tracker.count += 1;

        await supabase.from("dm_queue").update({
          status: sendResp.ok ? "sent" : "failed",
          error: sendResp.ok ? null : `HTTP ${sendResp.status}`,
          processed_at: new Date().toISOString(),
        }).eq("id", item.id);

        log("dm_queue_processed", {
          id: item.id,
          clientId: item.client_id,
          igPsid: item.ig_psid,
          sendOk: sendResp.ok,
        });
      } catch (e) {
        console.error("dm_queue item failed:", item.id, e?.message || e);
        await supabase.from("dm_queue").update({
          status: "failed",
          error: String(e?.message || e).slice(0, 200),
          processed_at: new Date().toISOString(),
        }).eq("id", item.id).catch(() => {});
      }
    }
  } catch (e) {
    console.error("processDmQueue error:", e?.message || e);
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
 * INSTAGRAM WEBHOOK (POST)
 * ===========================
 */

app.post("/webhook", async (req, res) => {
  try {
    const events = getAllIgMessagingEvents(req.body);
    const followEvents = extractFollowEvents(req.body);
    const commentEvents = extractPostCommentEvents(req.body);

    if (!events.length && !followEvents.length && !commentEvents.length) {
      return res.sendStatus(200);
    }

    res.sendStatus(200);

    for (const { igAccountId, followerId } of followEvents) {
      void handleNewFollowerDm(igAccountId, followerId);
    }

    for (const { igAccountId, commentId, commenterId, commentText } of commentEvents) {
      void handlePostCommentKeyword(igAccountId, commentId, commenterId, commentText);
    }

    for (const { messaging } of events) {
      void (async () => {
        try {
          const senderId = messaging.sender?.id;
          const recipientId = messaging.recipient?.id;
          const text = extractIgText(messaging);
          const isEcho = isIgEcho(messaging);

          log("ig_webhook_received", {
            senderId,
            recipientId,
            hasText: !!text,
            isEcho,
            hasAttachments: !!messaging?.message?.attachments?.length,
            rawMid: messaging?.message?.mid || null,
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

          const { data: igAccount, error: igLookupError } = await supabase
            .from("ig_accounts")
            .select("client_id, ig_user_id, page_id")
            .eq("is_active", true)
            .or(`page_id.eq.${recipientId},ig_user_id.eq.${recipientId}`)
            .maybeSingle();

          if (igLookupError || !igAccount?.client_id) {
            console.error("No active Instagram account/client mapping found", {
              recipientId,
              igLookupError: igLookupError?.message || null,
            });
            return;
          }

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
            const { data: newLead, error: newLeadError } = await supabase
              .from("leads")
              .insert({
                client_id: igAccount.client_id,
                ig_psid: senderId,
                stage: "new",
              })
              .select()
              .single();

            if (newLeadError) {
              console.error("lead create failed:", newLeadError);
              return;
            }

            lead = newLead;

            // Background: fetch and store lead's display name
            void (async () => {
              try {
                const acc = await getIgAccountByClientId(lead.client_id).catch(() => null);
                if (!acc?.page_access_token) return;
                const name = await lookupIgName(acc.page_access_token, senderId);
                if (name) {
                  await supabase.from("leads").update({ ig_name: name }).eq("id", lead.id);
                  lead = { ...lead, ig_name: name };
                }
              } catch (e) {
                console.warn("ig_name lookup failed:", e?.message || e);
              }
            })();
          }

          const { error: insertIncomingError } = await supabase
            .from("messages")
            .insert({
              lead_id: lead.id,
              direction: isEcho ? "out" : "in",
              text: text || "[non-text message]",
              created_at: new Date().toISOString(),
            });

          if (insertIncomingError) {
            console.error("messages insert incoming failed:", insertIncomingError);
          }

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

          let historyMessages = [];
          try {
            historyMessages = await getLeadMessageHistory(lead.id, 30);
          } catch {}

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

          if (lead.manual_override) {
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

const storyAutoDmMatched =
  !isEcho &&
  !alreadyHasOutbound &&
  shouldUseStoryAutoDm(cfg, messaging);

const commentAutoDmMatched =
  !isEcho &&
  !alreadyHasOutbound &&
  shouldUseCommentAutoDm(cfg, messaging);

const keywordAutoDmMatched =
  !isEcho &&
  !alreadyHasOutbound &&
  isPlainTextMessage(messaging) &&
  shouldUseKeywordAutoDm(cfg, text);

if (storyAutoDmMatched || commentAutoDmMatched || keywordAutoDmMatched) {
  const opener = storyAutoDmMatched
    ? getStoryAutoDmText(cfg)
    : commentAutoDmMatched
    ? getCommentAutoDmText(cfg)
    : getKeywordAutoDmText(cfg);

            if (opener) {
              const activeIgAccount = await getIgAccountByClientId(lead.client_id);

              if (!activeIgAccount?.page_access_token) {
                console.error(
                  "Missing Instagram access token for trigger opener:",
                  lead.client_id
                );
                return;
              }

              const { sendResp, sendData } = await sendInstagramTextMessage({
                accessToken: activeIgAccount.page_access_token,
                recipientId: senderId,
                text: opener,
              });

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
                  direction: "out",
                  text: opener,
                  created_at: new Date().toISOString(),
                });

              if (insertOutgoingError) {
                console.error(
                  "trigger opener insert outgoing failed:",
                  insertOutgoingError
                );
              }

              try {
                lead = await updateLeadTracking(lead.id, {
                  last_outbound_at: nowIso(),
                  last_outbound_text: opener,
                  stage: "warm",
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
          });

          turnStrategy = preventRepeatedReplyType(turnStrategy, leadMemory);

          lead.last_message = text;

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
          });

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

          if (!reply) return;

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
            const typingDelay = Math.min(words * 250, 5000);

            const rand = Math.random();
            let extraDelay;

            if (rand < 0.2) {
              extraDelay = Math.random() * 2000 + 1000;
            } else if (rand < 0.85) {
              extraDelay = Math.random() * 5000 + 3000;
            } else {
              extraDelay = Math.random() * 8000 + 8000;
            }

            const delay = typingDelay + extraDelay;
            await new Promise((res) => setTimeout(res, delay));

            // Feature 4: route through DM safety queue
            await queueDm({ clientId: lead.client_id, igPsid: senderId, text: msg });

            log("ig_message_queued", {
              leadId: lead.id,
              senderId,
              messagePreview: String(msg).slice(0, 120),
            });

            const { error: insertOutgoingError } = await supabase
              .from("messages")
              .insert({
                lead_id: lead.id,
                direction: "out",
                text: msg,
                created_at: new Date().toISOString(),
              });

            if (insertOutgoingError) {
              console.error("messages insert outgoing failed:", insertOutgoingError);
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
                stage: sentBookingLink ? "booking_pushed" : lead.stage,
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
              if (msg.length < 120 && !msg.includes("http")) {
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
          log("webhook_async_error", {
            error: err?.message || String(err),
          });
        }
      })();
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});
/**
 * ===========================
 * START SERVER
 * ===========================
 */

app.get("/auth/instagram/start", (req, res) => {
  return res.status(400).send("Use the dashboard Connect Instagram button.");
});

app.get("/auth/instagram/callback", async (req, res) => {
  try {
    if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
      return res.status(500).send("Meta env vars not configured");
    }

    const error = String(req.query.error || "");
    const errorReason = String(req.query.error_reason || "");
    const errorDescription = String(req.query.error_description || "");

    if (error) {
      return res.redirect(
        `/settings?instagram_connected=0&error=${encodeURIComponent(
          errorDescription || errorReason || error
        )}`
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

    const clientId = decoded.client_id;

    // Check if this coach already has an active Instagram connection
    const { data: existingIgAccount } = await supabase
      .from("ig_accounts")
      .select("id")
      .eq("client_id", clientId)
      .eq("is_active", true)
      .maybeSingle();
    const isFirstConnection = !existingIgAccount;

const tokenResp = await fetch(
  `https://graph.facebook.com/v23.0/oauth/access_token?client_id=${encodeURIComponent(
    META_APP_ID
  )}&redirect_uri=${encodeURIComponent(
    META_REDIRECT_URI
  )}&client_secret=${encodeURIComponent(
    META_APP_SECRET
  )}&code=${encodeURIComponent(code)}`
);

const tokenData = await tokenResp.json();

if (!tokenResp.ok || !tokenData?.access_token) {
  return res
    .status(500)
    .send(`Failed to exchange code: ${JSON.stringify(tokenData)}`);
}

const userAccessToken = tokenData.access_token;

const pagesResp = await fetch(
  `https://graph.facebook.com/v23.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}&access_token=${encodeURIComponent(
    userAccessToken
  )}`
);

const pagesData = await pagesResp.json();

if (!pagesResp.ok) {
  return res
    .status(500)
    .send(`Failed to fetch pages: ${JSON.stringify(pagesData)}`);
}

const page = (pagesData?.data || []).find(
  (p) =>
    p?.instagram_business_account?.id ||
    p?.connected_instagram_account?.id
);

if (!page) {
  return res
    .status(400)
    .send(
      `No Instagram professional account found. Full pages response: ${JSON.stringify(
        pagesData
      )}`
    );
}

const ig =
  page.instagram_business_account ||
  page.connected_instagram_account;

const { error: upsertErr } = await supabase.from("ig_accounts").upsert(
  {
    client_id: clientId,
    ig_user_id: ig.id,
    ig_username: ig.username || null,
    page_id: page.id,
    page_access_token: page.access_token,
    is_active: true,
  },
  { onConflict: "client_id" }
);

    if (upsertErr) {
      return res
        .status(500)
        .send(`Failed to save Instagram account: ${upsertErr.message}`);
    }

    if (isFirstConnection) {
      return res.redirect("/settings?instagram_connected=1");
    }
    return res.redirect("/coach/dashboard.html?instagram_connected=1");
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
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

function buildFollowUpText(leadMemory) {
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

      const text = buildFollowUpText(leadMemory);

      const { sendResp, sendData } = await sendInstagramTextMessage({
        accessToken: igAccount.page_access_token,
        recipientId: lead.ig_psid,
        text,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

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

  // Feature 4: DM Safety Queue — process every 30 seconds
  setInterval(() => {
    processDmQueue().catch((e) =>
      console.error("dm_queue: processor error", e?.message || e)
    );
  }, 30 * 1000);
});

