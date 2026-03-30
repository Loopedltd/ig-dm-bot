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
  return /how do i get started|how do i start|what do i do next|what happens next|how does the process work|what happens after i book|how does onboarding work/i.test(
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

function humaniseText(text) {
  let t = String(text || "").trim();
  if (!t) return t;

  if (Math.random() < 0.4) {
    t = t.charAt(0).toLowerCase() + t.slice(1);
  }

  if (Math.random() < 0.5) {
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
function getDefaultFallbackExamples() {
  return [
    {
      user: "i'm not sure what skill to focus on",
      assistant: "fair, what are you actually leaning toward right now?",
    },
    {
      user: "i want to make more money online",
      assistant: "yeah makes sense, what have you tried already?",
    },
    {
      user: "how does it work",
      assistant: "pretty simple, i’ll explain it properly but first where are you at right now?",
    },
    {
      user: "how much is it?",
      assistant: "i’ll run you through it properly, easiest thing is to get you booked in here",
    },
    {
      user: "i want it",
      assistant: "perfect, use this and get yourself booked in",
    },
    {
      user: "send me the link",
      assistant: "here you go, get booked in and we’ll take it from there",
    },
    {
      user: "i’ll think about it",
      assistant: "yeah that’s fine, what do you need to see to make a decision?",
    },
    {
      user: "not sure if it’s for me",
      assistant: "fair, what’s making you unsure?",
    },
    {
      user: "sounds good",
      assistant: "good, then let’s stop dragging it out and get you booked in",
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
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0,
      max_tokens: 220,
      response_format: { type: "json_object" },
    });

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
  return /ready|start|sign up|book|buy|join|i want it|let's do it|lets do it|how do i start|send me the link|where do i sign up|how do i join/i.test(
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
  return /what is this|what's this|whats this|how does it work|what do you actually do|what do you help with|tell me more|how does this work/i.test(
    String(text || "")
  );
}

function detectQuestionAfterLink(text) {
  return /what is this|what's this|whats this|how much|price|cost|how does it work|tell me more|what do you mean|what is included|what do i get/i.test(
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
    t.includes("cant afford") ||
    t.includes("can't afford") ||
    t.includes("price") ||
    t.includes("cost")
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

function decideTurnStrategy({
  lead,
  leadMemory,
  text,
  bookingUrl,
  cfg,
}) {
const currentText = String(text || "").trim();
const objectionType = detectObjectionType(currentText);
const asksPrice = detectPriceQuestion(currentText);
const asksOfferQuestion = detectOfferQuestion(currentText);
const asksStartProcess = detectStartProcessQuestion(currentText);
const asksWhoItsFor = detectWhoItsForQuestion(currentText);
const asksWhatYouSell = detectWhatYouSellQuestion(currentText);
const explicitLinkRequest = detectExplicitBookingLinkRequest(currentText);
const questionAfterLink = detectQuestionAfterLink(currentText);
const intentScore = inferIntentScore(currentText, leadMemory);
const qualificationPresent = hasUsefulQualification(leadMemory);

  if (bookingRecentlySent && asksStartProcess) {
    return {
      type: "answer_start_process_after_cta",
      asksPrice,
      asksOfferQuestion,
      asksStartProcess,
      asksWhoItsFor,
      asksWhatYouSell,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (bookingRecentlySent && asksWhoItsFor) {
    return {
      type: "answer_who_its_for_after_cta",
      asksPrice,
      asksOfferQuestion,
      asksStartProcess,
      asksWhoItsFor,
      asksWhatYouSell,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (bookingRecentlySent && asksWhatYouSell) {
    return {
      type: "answer_what_you_sell_after_cta",
      asksPrice,
      asksOfferQuestion,
      asksStartProcess,
      asksWhoItsFor,
      asksWhatYouSell,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  const bookingRecentlySent =
    !!lead?.booking_sent ||
    !!leadMemory?.last_cta_at ||
    (leadMemory?.booking_link_sent_count || 0) > 0;

  if (lead?.call_completed) {
    return {
      type: "post_call_support",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (explicitLinkRequest && bookingUrl) {
    return {
      type: "send_booking_link_now",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (bookingRecentlySent && asksPrice) {
    return {
      type: "answer_price_after_cta",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (bookingRecentlySent && asksOfferQuestion) {
    return {
      type: "answer_offer_question_after_cta",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (bookingRecentlySent && questionAfterLink) {
    return {
      type: "answer_question_after_cta",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (objectionType === "think_about_it") {
    return {
      type: "handle_think_about_it",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (asksPrice && bookingUrl) {
    return {
      type: "handle_price_then_cta",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  if (bookingUrl && intentScore >= 4 && !bookingRecentlySent) {
    return {
      type: "send_booking_link_now",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (qualificationPresent && bookingUrl && intentScore >= 2 && !bookingRecentlySent) {
    return {
      type: "soft_close_to_booking",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: true,
    };
  }

  if (!qualificationPresent) {
    return {
      type: "ask_qualifying_question",
      asksPrice,
      asksOfferQuestion,
      objectionType,
      intentScore,
      shouldSendBookingLink: false,
    };
  }

  return {
    type: "nudge_forward",
    asksPrice,
    asksOfferQuestion,
    objectionType,
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
}) {
  if (!openai) return null;

const systemBase =
  shouldUseCustomSystemPrompt(cfg)
    ? cfg.system_prompt
    : `
You are a high-converting Instagram DM setter and closer.

You talk like a real person in Instagram DMs, not a sales rep, not support, and not a chatbot.

PRIMARY JOB:
Move the conversation toward a booked call or clear next step as fast as naturally possible.

CORE BEHAVIOUR:
- Be direct, calm, confident, and conversational
- Sound like someone who does this all day
- Keep replies short
- Do not over-explain
- Do not act needy
- Do not try to impress the lead with long answers
- Lead the conversation instead of reacting passively
- If the lead is warm, stop over-qualifying and move forward
- If the lead is high intent, close immediately
- If the lead hesitates, stay composed and pull out the real objection

HOW YOU SHOULD SOUND:
- casual
- slightly blunt
- socially aware
- confident without sounding try-hard
- relaxed, not stiff
- not overly enthusiastic
- not corporate
- imperfect grammar is fine if natural

WHAT TO AVOID:
- long paragraphs
- corporate phrasing
- “happy to help”
- “let me know”
- “I’d love to”
- over-validation
- fake excitement
- multiple questions at once
- repeating the same question in different words

CLOSING RULE:
If the lead is ready, interested, asks how it works, asks price, asks how to start, or asks for the link, your default bias should be to move them toward booking instead of stretching the conversation.

QUESTION RULE:
Only ask a question when it genuinely helps move the sale forward.

MESSAGE LENGTH:
Usually 1 sentence.
Max 2 short sentences.

GOAL:
Make the lead feel like they’re speaking to a sharp human closer who knows where the conversation is going.
`;
const guardrails = [
  "Keep replies short (1-2 sentences).",
  "Ask ONE clear question OR move to a clear next step.",
  "Do not mention OpenAI or AI.",
  "No emojis by default.",
  "Do not use em dashes or double hyphens.",
  "Do not repeat yourself or re-ask questions already answered.",
  "Move the conversation forward toward a decision.",
"Never ask the same type of question twice in a row.",
"After 1–2 questions, move toward a decision or booking.",
"If the conversation stalls, guide toward booking instead of asking more questions.",
  "Use lead_memory to avoid asking for info the user has already given.",
  "If lead_memory already contains the answer, do not ask for it again.",
  "Do not sound overeager or overly friendly.",
  "Do not use customer support language.",
  "Do not write like a copywriter.",
  "Prefer confident plain wording over polished wording.",
  "If booking is the obvious next step, do not hide behind another question.",
  "If the user is vague, ask the most useful direct question, not a broad one.",
  "Do not give motivational speeches.",
  "If the user asks what the offer is, what the coach helps with, who it is for, or how getting started works, answer directly.",
  "Do not dodge real questions by repeating a booking instruction.",
  "After the booking link has been sent once, your default should be to answer follow-up questions, not repeat the CTA.",
  "Only reuse booking language when it genuinely helps the conversation move forward.",
  "If the user asks how to get started, explain the process clearly instead of repeating that they can book.",
  "Vary your wording. Do not repeat the same sentence structure across replies.",

  // 🔥 SALES RULES (NEW)
  "If user clearly asks for the booking link or says they are ready to buy, send the booking link immediately.",
  "Do not resend the booking link if it was already sent unless the user explicitly asks for it again.",
  "If the user asks a real follow-up question after the link was sent, answer the question first.",
  "If user is warm, guide them toward booking without sounding repetitive.",
  "If user is cold, ask 1 simple question.",
  "Never stay stuck in qualification loop.",
  "If asked about price and offer_price exists in context, say it clearly and naturally.",
  "If asked what the offer is and offer_description exists in context, explain it clearly in plain English.",
  "Do not invent prices. If price is unknown, be honest and keep the reply natural.",
  `Tone: ${getEffectiveTone(cfg)}.`,
  `Style: ${getEffectiveStyle(cfg)}.`,
  `Vocabulary: ${getEffectiveVocabulary(cfg)}.`,
];

  const objectionRules = thinkAboutIt
    ? [
        "The user is giving a 'I'll think about it' objection.",
        "Acknowledge calmly, reduce pressure, and ask what they need to decide.",
      ]
    : [];

  const postCallRules = postCallMode
    ? [
        "This user has already completed a call.",
        "Use a matey supportive UK tone.",
        "Do NOT push booking links or ask them to book a call.",
      ]
    : [
        "This user has not completed a call yet.",
        "Qualify them: goal, timeline, current situation.",
      ];
const strategyRules =
  turnStrategy?.type === "send_booking_link_now"
    ? [
        "TURN STRATEGY: send_booking_link_now",
        "Do not ask a question first.",
        "Send or direct the user to the booking link immediately.",
        "Be confident and assume intent is real.",
      ]
    : turnStrategy?.type === "handle_price_then_cta"
    ? [
        "TURN STRATEGY: handle_price_then_cta",
        "Answer the price question briefly and clearly.",
        "If offer_price exists in context, use it directly.",
        "Do not resend the booking link unless the user asks for it.",
        "After answering, you can give a light next step.",
      ]
    : turnStrategy?.type === "answer_price_after_cta"
    ? [
        "TURN STRATEGY: answer_price_after_cta",
        "The booking link has already been sent before.",
        "Do not resend the booking link.",
        "Answer the user's price question directly.",
        "If offer_price exists in context, use it plainly.",
        "After answering, you may add a light nudge, but do not push hard.",
      ]
    : turnStrategy?.type === "answer_offer_question_after_cta"
    ? [
        "TURN STRATEGY: answer_offer_question_after_cta",
        "The booking link has already been sent before.",
        "Do not resend the booking link.",
        "Answer what the offer is in plain English.",
        "If offer_description exists in context, use it naturally.",
        "Do not dodge the question.",
      ]
    : turnStrategy?.type === "answer_question_after_cta"
    ? [
        "TURN STRATEGY: answer_question_after_cta",
        "The booking link has already been sent before.",
        "Do not resend the booking link.",
        "Answer the user's question first.",
        "Sound calm and human, not pushy.",
      ]
    : turnStrategy?.type === "handle_think_about_it"
    ? [
        "TURN STRATEGY: handle_think_about_it",
        "Do not accept the stall passively.",
        "Acknowledge calmly and ask what they need to decide.",
        "Keep pressure low but keep the conversation moving.",
      ]
    : turnStrategy?.type === "soft_close_to_booking"
    ? [
        "TURN STRATEGY: soft_close_to_booking",
        "The user is warm enough to move forward.",
        "Guide them toward booking instead of asking more qualifiers.",
      ]
    : turnStrategy?.type === "ask_qualifying_question"
    ? [
        "TURN STRATEGY: ask_qualifying_question",
        "Ask one useful question only.",
        "Ask for the most important missing sales context.",
        "Do not ask something already stored in lead_memory.",
      ]
    : turnStrategy?.type === "nudge_forward"
    ? [
        "TURN STRATEGY: nudge_forward",
        "Do not restart qualification from scratch.",
        "Move the user toward a decision or next step.",
      ]
    : turnStrategy?.type === "post_call_support"
    ? [
        "TURN STRATEGY: post_call_support",
        "Be helpful and supportive.",
        "Do not push booking.",
      ]
      : turnStrategy?.type === "answer_start_process_after_cta"
      ? [
          "TURN STRATEGY: answer_start_process_after_cta",
          "The booking link has already been sent.",
          "Do not resend the booking link unless the user explicitly asks for it again.",
          "Answer how getting started works in plain English.",
          "Explain the process step by step briefly.",
          "Typical flow: book through the link, choose a time, attend the call, then onboarding / next steps.",
          "Sound clear, calm and human.",
        ]
      : turnStrategy?.type === "answer_who_its_for_after_cta"
      ? [
          "TURN STRATEGY: answer_who_its_for_after_cta",
          "The booking link has already been sent.",
          "Do not resend the booking link.",
          "Answer who the offer is for directly.",
          "Use offer_description if available.",
          "Do not dodge the question.",
        ]
      : turnStrategy?.type === "answer_what_you_sell_after_cta"
      ? [
          "TURN STRATEGY: answer_what_you_sell_after_cta",
          "The booking link has already been sent.",
          "Do not resend the booking link.",
          "Answer what the coach actually sells in plain English.",
          "Use offer_description if available.",
          "Do not default back to generic booking language.",
        ]
    : [];
const parsedExamples = parseExampleMessages(cfg?.example_messages);
const examplesToUse =
  hasStrongCustomExamples(cfg?.example_messages)
    ? parsedExamples
    : getDefaultFallbackExamples();

const exampleMessages = examplesToUse.flatMap((ex) => [
  { role: "user", content: ex.user },
  { role: "assistant", content: ex.assistant },
]);

  const context = {
    lead_stage: lead?.stage ?? null,
    call_completed: lead?.call_completed ?? false,
    booking_sent: lead?.booking_sent ?? false,
    booking_url_present: !!bookingUrl,
    offer_description: cfg?.offer_description || null,
    offer_price: cfg?.offer_price || null,   
 user_asked_price: asksPrice,
    user_high_intent: highIntent,
    think_about_it_objection: !!thinkAboutIt,
    manual_override: !!lead?.manual_override,
    bot_paused: !!cfg?.bot_paused,
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
        }
      : null,
    turn_strategy: turnStrategy
      ? {
          type: turnStrategy.type,
          asksPrice: !!turnStrategy.asksPrice,
          objectionType: turnStrategy.objectionType || null,
          intentScore: turnStrategy.intentScore ?? null,
          shouldSendBookingLink: !!turnStrategy.shouldSendBookingLink,
        }
      : null, 
 };

const messages = [
  {
    role: "system",
content: [
  systemBase,
  "",
  "RULES:",
  ...guardrails.map((x) => `- ${x}`),
  ...postCallRules.map((x) => `- ${x}`),
  ...strategyRules.map((x) => `- ${x}`),
  ...objectionRules.map((x) => `- ${x}`),
  "",
  "EXAMPLE USAGE RULES:",
  "- Match the tone, wording, and sentence length of the examples.",
  "- Do not copy examples word-for-word.",
  "- Examples override generic style rules.",
  "",
  "CONTEXT:",
  JSON.stringify(context, null, 2),
].join("\n"),
  },
  ...exampleMessages,
  ...(historyMessages || []),
];

  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
temperature: 0.45,
      max_tokens: 160,
    });

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

return sanitizeReply(stripWeakPhrases(text));
  } catch (e) {
    console.warn("⚠️ OpenAI error, falling back:", e?.message || e);
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

const url = `${APP_BASE_URL}/checkout?token=${token}`;

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
const { instagram_handle, example_messages, offer_description, offer_price } = req.body || {};
    const handleRaw = String(instagram_handle || "").trim();

    if (!handleRaw) {
      return safeJson(res, 400, { error: "instagram_handle is required" });
    }

    const handle = handleRaw.startsWith("@") ? handleRaw.slice(1) : handleRaw;
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) {
      return safeJson(res, 400, { error: "invalid instagram handle format" });
    }

    const { data: cfg } = await supabase
  .from("client_configs")
      .select("*")
      .eq("client_id", req.coach.client_id)
      .single();
const exampleMessages =
  String(example_messages || cfg?.example_messages || "").trim();
const offerDescription =
  String(offer_description || cfg?.offer_description || "").trim();
const offerPrice =
  String(offer_price || cfg?.offer_price || "").trim();
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

WHAT THE COACH SELLS:
${offerDescription || "(not provided)"}

PRICE:
${offerPrice || "(not provided)"}

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
return_url: `${APP_BASE_URL}/dashboard`,
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

  success_url: `${APP_BASE_URL}/success?paid=1&session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${APP_BASE_URL}/cancel?cancelled=1`,
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

    console.log("IG WEBHOOK messaging:", JSON.stringify(messaging, null, 2));
    console.log("senderId:", senderId);
    console.log("recipientId:", recipientId);

    if (!senderId || !text) return res.sendStatus(200);

    res.sendStatus(200);

    void (async () => {
      try {
        let { data: lead } = await supabase
          .from("leads")
          .select("*")
          .eq("ig_psid", senderId)
          .single();

        if (!lead) {
          const { data: igAccount } = await supabase
            .from("ig_accounts")
            .select("client_id, ig_user_id, page_id")
            .eq("is_active", true)
            .single();

          if (!igAccount?.client_id) {
            console.error("No active Instagram account/client mapping found");
            return;
          }

          const { data: newLead } = await supabase
            .from("leads")
            .insert({
              client_id: igAccount.client_id,
              ig_psid: senderId,
              stage: "new",
            })
            .select()
            .single();

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

          if (extractedMemory) {
            leadMemory = await upsertLeadMemory({
              leadId: lead.id,
              clientId: lead.client_id,
              patch: extractedMemory,
              existing: leadMemory,
            });
          }
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
const turnStrategy = decideTurnStrategy({
  lead,
  leadMemory,
  text,
  bookingUrl: cfg?.booking_url || null,
  cfg,
});

        lead.last_message = text;

        let reply = await generateAiReply({
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
        });

if (turnStrategy?.type === "send_booking_link_now" && cfg?.booking_url) {
  const ctaOptions = [
    `${cfg.booking_url}\n\nbook in here and we’ll get you sorted`,
    `${cfg.booking_url}\n\nuse this and pick a time that works for you`,
    `${cfg.booking_url}\n\nbook through here and we’ll take it from there`,
  ];

  reply = ctaOptions[Math.floor(Math.random() * ctaOptions.length)];
}

        if (!reply) return;

        reply = humaniseText(reply);

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

        const igAccount = await getIgAccountByClientId(lead.client_id);

        if (!igAccount?.page_access_token) {
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

          const sendResp = await fetch(
            `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
              igAccount.page_access_token
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

          console.log("SEND PART:", msg);
          console.log("SEND OK:", sendResp.ok);
          console.log("SEND DATA:", JSON.stringify(sendData, null, 2));

          if (!sendResp.ok) {
            throw new Error(`Failed to send IG message: ${JSON.stringify(sendData)}`);
          }

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

            if (sentBookingLink) {
              leadMemory = await upsertLeadMemory({
                leadId: lead.id,
                clientId: lead.client_id,
                existing: leadMemory,
                patch: {
                  last_cta_type: "booking_link",
                  last_cta_at: nowIso(),
                  booking_link_sent_count:
                    (leadMemory?.booking_link_sent_count || 0) + 1,
                },
              });
            }
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
        console.error("Webhook async error:", err);
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

