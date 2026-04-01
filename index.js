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
  return messaging?.message?.text || messaging?.message?.attachments?.[0]?.payload?.url || "";
}

function isIgEcho(messaging) {
  return !!messaging?.message?.is_echo;
}

function parseIgEvent(reqBody) {
  const entry = reqBody?.entry?.[0];
  const messaging = entry?.messaging?.[0];
  return { entry, messaging };
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

function humaniseText(text) {
  let t = String(text || "").trim();
  if (!t) return t;

  if (Math.random() < 0.4) {
    t = t.charAt(0).toLowerCase() + t.slice(1);
  }

if (Math.random() < 0.3) {
  t = t.replace(/[.!]/g, "");
}

  t = t
    .replace(/\bgoing to\b/gi, "gonna")
    .replace(/\bwant to\b/gi, "wanna");

  if (Math.random() < 0.2) {
    const fillers = ["yeah", "fair", "ahh ok", "got you", "makes sense"];
    t = `${fillers[Math.floor(Math.random() * fillers.length)]}\n\n${t}`;
  }

  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function splitIntoMessages(text) {
  if (!text) return [];

  let parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 1 && text.length > 80) {
    const words = text.split(" ");
    const mid = Math.floor(words.length / 2);
    parts = [
      words.slice(0, mid).join(" "),
      words.slice(mid).join(" "),
    ];
  }

  return parts;
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

function getStructuredOfferContext(cfg) {
  const raw = String(cfg?.offer_description || "").trim();

  return {
    what_you_do:
      String(cfg?.what_you_do || "").trim() ||
      extractOfferSection(raw, "What you do", "What they get") ||
      "",
    what_they_get:
      String(cfg?.what_they_get || "").trim() ||
      extractOfferSection(raw, "What they get", "Who it's for") ||
      "",
    who_its_for:
      String(cfg?.who_its_for || "").trim() ||
      extractOfferSection(raw, "Who it's for", "How it works") ||
      "",
    how_it_works:
      String(cfg?.how_it_works || "").trim() ||
      extractOfferSection(raw, "How it works") ||
      "",
  };
}
function getDefaultFallbackExamples() {
  return [
    {
      user: "what do you actually help with",
      assistant:
        "I help people get a clear result without all the guesswork - proper support, a clear plan, and accountability so they actually follow through. What are you trying to sort out right now?",
    },
    {
      user: "how much is it?",
      assistant:
        "I can break the price down properly for you. Want me to send the details?",
    },
    {
      user: "how does it work",
      assistant:
        "You get booked in, we look at where you're at, what needs fixing, then everything gets set up properly from there. Want me to send the link?",
    },
    {
      user: "i want it",
      assistant:
        "Good. I’ll send the link and you can get started.",
    },
    {
      user: "send me the link",
      assistant:
        "Here you go - pick what works for you and we’ll get moving.",
    },
    {
      user: "i’ll think about it",
      assistant:
        "Fair. What’s the main thing stopping you right now?",
    },
    {
      user: "not sure if it’s for me",
      assistant:
        "What part are you unsure about - the price, the process, or whether it fits what you need?",
    },
    {
      user: "that’s a bit much",
      assistant:
        "Fair. What were you expecting to pay if someone was actually gonna help you do this properly?",
    },
    {
      user: "sounds good",
      assistant:
        "Calm. Want me to send the link so you can get started properly?",
    },
    {
      user: "what do i get",
      assistant:
        "You get proper support, a clear plan, and accountability so you actually stay on track. Want me to send the link?",
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
- last_question_asked should only capture the assistant's latest meaningful question if one exists
- objection should capture the user's main hesitation if present
- summary should be 1 short sentence max

Return exactly this shape:
{
  "summary": null,
  "goal": null,
  "current_situation": null,
  "pain_points": null,
  "desired_outcome": null,
  "objection": null,
  "intent_level": null,
  "last_question_asked": null
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
    leadMemory?.desired_outcome
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
  `fair - what’s the main thing holding you back?`,
  `all good - what do you need to see before you can decide properly?`,
  `got you - is it price, timing or not being fully sure yet?`,
],
    ask_qualifying_question: [
      `what are you trying to sort out right now?`,
      `what’s the main result you want at the minute?`,
    ],
    nudge_forward: [
      `got you - what’s the main thing stopping you from moving on it now?`,
      `fair - are you just looking around or do you actually want help with it?`,
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

return `I help people get a proper result without all the guesswork - clear plan, proper support, and accountability so they actually follow through.`;
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
  const objection = String(leadMemory?.objection || "").toLowerCase();

  if (bookingSent) {
    if (
      userIntent === "price_question" ||
      userIntent === "offer_question" ||
      userIntent === "what_do_i_get_question" ||
      userIntent === "start_process_question" ||
      userIntent === "who_its_for_question"
    ) {
      return "post_cta_followup";
    }

    return "booking_cta_sent";
  }

  if (objection) return "objection_handling";

  if (hasQualification && leadMemory?.intent_level === "hot") {
    return "ready_to_close";
  }

  if (hasQualification && leadMemory?.intent_level === "warm") {
    return "warm_qualified";
  }

  if (hasQualification) {
    return "qualified";
  }

  return "new_lead";
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

  if (conversationState === "post_call") {
    return {
      type: "post_call_support",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  // 1. HIGH INTENT -> CLOSE
  if (
    (userIntent === "booking_link_request" ||
      userIntent === "high_intent" ||
      intentScore >= 4) &&
    hasBookingUrl &&
    !bookingRecentlySent
  ) {
    return {
      type: "send_booking_link_now",
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  // 2. OBJECTION -> PROBE
  if (
    userIntent === "think_about_it" ||
    detectObjectionType(text)
  ) {
    return {
      type: "handle_think_about_it",
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  // 3. QUESTION -> ANSWER
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

  // warm but not fully explicit yet
  if (
    (userIntent === "soft_intent" || intentScore >= 2 || conversationState === "warm_qualified") &&
    hasBookingUrl &&
    !bookingRecentlySent
  ) {
    return {
      type: "soft_close_to_booking",
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  // 4. EARLY -> QUALIFY
  if (!hasQualification || conversationState === "new_lead") {
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
    leadMemory?.desired_outcome
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

function shouldUseCustomSystemPrompt(cfg) {
  const prompt = String(cfg?.system_prompt || "").trim();
  return prompt.length >= 120;
}

function getEscalatedBookingReply(bookingUrl, leadMemory, mode = "normal") {
  if (!bookingUrl) return null;

  const attempts = Number(leadMemory?.cta_attempts || 0);

  if (mode === "soft") {
    if (attempts <= 0) {
      return `makes sense - use this and grab a slot that works for you ${bookingUrl}`;
    }

    if (attempts === 1) {
      return `best next step is just get booked in here and we’ll go through it properly ${bookingUrl}`;
    }

    return `${bookingUrl}\n\nif you want to do it properly, book in and we’ll get it moving`;
  }

  if (attempts <= 0) {
    return `${bookingUrl}\n\nuse this and pick a time that works for you`;
  }

  if (attempts === 1) {
    return `${bookingUrl}\n\nbook in here and we’ll get you sorted properly`;
  }

  return `${bookingUrl}\n\nif you’re serious about sorting it, book in and let’s get moving`;
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

  const examplesToUse = hasStrongCustomExamples(cfg?.example_messages)
    ? parseExampleMessages(cfg?.example_messages)
    : getDefaultFallbackExamples();

  const exampleMessages = examplesToUse.flatMap((ex) => [
    { role: "user", content: ex.user },
    { role: "assistant", content: ex.assistant },
  ]);

  const systemPrompt = `
You are a high-converting Instagram DM closer.

Your job is to reply like a real person in DMs and move the conversation forward naturally.

VOICE PRIORITY:
1. match the example messages first
2. then follow the coach tone/style/vocabulary
3. if they conflict, example messages win

NON-NEGOTIABLE RULES:
- sound human, casual, direct
- keep replies concise
- for simple answers, use 1-2 short sentences
- for objections or process explanations, you can use 2-4 short message-like lines
- sound like texting, not an essay
- answer the user's actual question directly
- do not dodge questions with vague filler
- do not sound like support
- do not sound corporate
- do not use em dashes
- do not use emojis by default
- do not repeat the same meaning as recent assistant replies
- you are replying on behalf of one specific business
- use only the offer, tone, examples, price, process, and fit information provided in context
- never assume this is fitness unless the provided context clearly says so
- never assume this is money coaching unless the provided context clearly says so
- do not invent services, outcomes, pricing, deliverables, or niche details
QUESTION RULE (IMPORTANT):

Only ask a question if it moves the conversation forward.

DO NOT ask a question when:
- the user asked for something specific (price, explanation, link)
- the user already has high intent and is ready
- a direct answer is clearly enough

DO ask a question when:
- you need to uncover hesitation or objection
- the user is vague or early in the conversation
- you are trying to move them toward booking

When you DO ask a question:
- ask only ONE
- keep it short
- it must move toward a decision, booking, or real objection

Examples of good questions:
- "want me to send the link?"
- "what’s the main thing stopping you?"
- "is it price, timing, or not fully sold yet?"

Avoid:
- "what do you think?"
- "how are you feeling about it?"
- anything vague or passive
- good follow-up questions are things like:
  - "want me to send the link?"
  - "do you want to get started properly?"
  - "what’s the main thing stopping you?"
  - "is it the price, timing, or just not fully sold yet?"
- bad follow-up questions are vague ones like:
  - "tell me more"
  - "how are you feeling about it"
  - "what are your thoughts"

IMPORTANT:
The user may phrase questions badly.
You must infer the meaning and answer the intent, not just exact wording.

If the user message is basically asking:
- what is it -> explain the offer plainly
- what do I get -> explain deliverables plainly
- how does it work -> explain the process plainly
- who is it for -> explain fit plainly
- how much -> answer price plainly
- I'll think about it -> handle objection calmly and ask what they need to decide

OBJECTION RULE:
If the user hesitates, says it is expensive, says they are not sure, or says they will think about it:
- do NOT comfort them with weak validation
- do NOT jump straight to the booking link
- first ask a sharp, simple question to find the real issue
- examples:
  - "fair, what’s the main thing holding you back?"
  - "what part are you unsure about?"
  - "compared to what?"
  - "what were you expecting to pay?"

CTA ESCALATION RULE:
- if cta_attempts is 0, keep closes light and easy
- if cta_attempts is 1, be a bit firmer and clearer
- if cta_attempts is 2 or more, be more direct and decisive
- do not repeat the exact same CTA wording
- if last_cta_response shows hesitation, address that first before closing again

Return ONLY valid JSON in this exact shape:
{
  "reply": "string",
  "reply_type": "answer|answer_then_nudge|question|close|objection",
  "should_send_booking_link": false
}
  `.trim();

  const context = {
    user_message: userText,
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
  };

  const messages = [
    {
      role: "system",
      content: systemPrompt,
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

    reply = sanitizeReply(stripOverusedFillers(stripWeakPhrases(reply)));

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
  const offerDescription = String(cfg?.offer_description || "").trim();

  if (raw) {
    const weakPhrases = [
      "tailored service",
      "help people get results",
      "support and guidance",
      "journey",
    ];

    const lower = raw.toLowerCase();
    const weakHit = weakPhrases.some((p) => lower.includes(p));

    if (raw.length >= 35 && !weakHit) {
      return raw;
    }
  }

  if (offerDescription) {
    return "I help people get a proper result with a clear plan, the right support, and a process that actually helps them follow through.";
  }

  return "I help people get a proper result with a clear plan, the right support, and a process that actually helps them follow through.";
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
  return data;
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
      .single();

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
    offer_description: null,
    offer_price: null,
    what_you_do: null,
    what_they_get: null,
    how_it_works: null,
    who_its_for: null,
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
  "id,created_at,ig_psid,stage,booking_sent,call_completed,manual_override,manual_override_reason,manual_override_by,manual_override_at"
)
      .eq("client_id", req.coach.client_id)
      .order("created_at", { ascending: false })
      .limit(300);

    if (error) return safeJson(res, 500, error);

    return safeJson(res, 200, { ok: true, leads: leads || [] });
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

// ✅ increment usage AFTER successful generation
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
 * INSTAGRAM WEBHOOK
 * ===========================
 */

app.post("/webhook", async (req, res) => {
  try {
    const { messaging } = parseIgEvent(req.body);

    if (!messaging) return res.sendStatus(200);

    const senderId = messaging.sender?.id;
    const recipientId = messaging.recipient?.id;
    const text = extractIgText(messaging);
    const isEcho = isIgEcho(messaging);

log("ig_webhook_received", {
  senderId,
  recipientId,
  hasText: !!text,
  isEcho,
});

    if (!senderId || !text) return res.sendStatus(200);

    res.sendStatus(200);

void (async () => {
  try {
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
    }

        const { error: insertIncomingError } = await supabase.from("messages").insert({
          lead_id: lead.id,
          direction: isEcho ? "out" : "in",
          text,
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

        let historyMessages = [];
        try {
          historyMessages = await getLeadMessageHistory(lead.id, 30);
        } catch {}

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
  ["think_about_it", "price_question", "offer_question", "what_do_i_get_question", "start_process_question", "who_its_for_question"].includes(userIntent)
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

const explicitLinkRequest = detectExplicitBookingLinkRequest(text);
const bookingAlreadySent =
  !!lead?.booking_sent ||
  !!leadMemory?.last_cta_at ||
  (leadMemory?.booking_link_sent_count || 0) > 0;

const canSendNewBookingPush = cfg?.booking_url && !bookingAlreadySent;
const canResendBecauseAsked = cfg?.booking_url && explicitLinkRequest;

// explicit ask always wins
if (canResendBecauseAsked) {
  reply = getEscalatedBookingReply(cfg.booking_url, leadMemory, "normal");
}
else if (aiResult?.should_send_booking_link && canSendNewBookingPush) {
  const closeMode =
    turnStrategy?.type === "soft_close_to_booking" ? "soft" : "normal";

  reply = getEscalatedBookingReply(cfg.booking_url, leadMemory, closeMode);
}
else if (highIntent && canSendNewBookingPush) {
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

const shouldHumanise =
  ![
    "answer_price_after_cta",
    "handle_price_then_cta",
    "answer_offer_question_after_cta",
    "answer_what_you_sell_after_cta",
    "answer_what_do_i_get_after_cta",
    "answer_start_process_after_cta",
    "answer_who_its_for_after_cta",
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

const activeIgAccount = await getIgAccountByClientId(lead.client_id);

if (!activeIgAccount?.page_access_token) {
  console.error("Missing Instagram access token for client:", lead.client_id);
  return;
}

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

const { sendResp, sendData } = await sendWithRetry(async () => {
  const sendResp = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
activeIgAccount.page_access_token
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: msg },
      }),
    }
  );

  const sendData = await sendResp.json().catch(() => null);

  if (!sendResp.ok) {
    throw new Error(`Failed to send IG message: ${JSON.stringify(sendData)}`);
  }

  return { sendResp, sendData };
});
log("ig_message_sent", {
  leadId: lead.id,
  senderId,
  messagePreview: String(msg).slice(0, 120),
  sendOk: sendResp.ok,
  sendData,
});
          const { error: insertOutgoingError } = await supabase.from("messages").insert({
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
              !!cfg?.booking_url && String(msg).includes(String(cfg.booking_url));

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
        `/coach/dashboard.html?instagram_connected=0&error=${encodeURIComponent(
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

    return res.redirect("/coach/dashboard.html?instagram_connected=1");
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

