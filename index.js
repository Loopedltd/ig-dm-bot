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

  // Remove dashy punctuation that reads “AI-ish” in DMs
  out = out.replace(/[—–]/g, " ");
  out = out.replace(/--+/g, " ");
  out = out.replace(/\s-\s/g, " ");

  // Strip emojis by default
  out = out.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,
    ""
  );

  // Cleanup spacing
  out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}

async function getLeadMessageHistory(leadId, limit = 10) {
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

async function generateAiReply({
  cfg,
  lead,
  historyMessages,
  postCallMode,
  asksPrice,
  highIntent,
  bookingUrl,
  thinkAboutIt,
}) {
  if (!openai) return null;

  const systemBase =
    cfg?.system_prompt ||
    "You are the coach's Instagram DM assistant. Be friendly, concise, and human. Ask one question at a time.";

  const guardrails = [
    "Keep replies short (1-3 sentences).",
    "Ask ONE clear question at the end unless giving a booking link is clearly the next step.",
    "Do not mention OpenAI or AI.",
    "No emojis by default.",
    "Do not use em dashes or double hyphens.",
    "Do not repeat yourself or re-ask questions already answered.",
    "Move the conversation forward toward one clear next step.",
    "Do not invent prices. If asked about price, ask goal and current situation and say exact options will be confirmed.",
    "Never spam. No follow-up threats.",
  ];

  const objectionRules = thinkAboutIt
    ? [
        "The user is giving a 'I'll think about it' objection.",
        "Acknowledge calmly, reduce pressure, and ask what they need to decide.",
        "Offer a quick recap and ask whether they want the booking link now or later.",
      ]
    : [];

  const postCallRules = postCallMode
    ? [
        "This user has already completed a call.",
        "Use a matey supportive UK tone.",
        "Do NOT push booking links or ask them to book a call.",
        "Focus on next steps: training, nutrition, accountability, onboarding info.",
      ]
    : [
        "This user has not completed a call yet.",
        "Qualify them: goal, timeline, current situation.",
      ];

  const context = {
    lead_stage: lead?.stage ?? null,
    call_completed: lead?.call_completed ?? false,
    booking_sent: lead?.booking_sent ?? false,
    booking_url_present: !!bookingUrl,
    user_asked_price: asksPrice,
    user_high_intent: highIntent,
    think_about_it_objection: !!thinkAboutIt,
    manual_override: !!lead?.manual_override,
    bot_paused: !!cfg?.bot_paused,
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
        ...objectionRules.map((x) => `- ${x}`),
        "",
        "CONTEXT (JSON):",
        JSON.stringify(context),
      ].join("\n"),
    },
    ...(historyMessages || []),
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.6,
      max_tokens: 160,
    });

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return sanitizeReply(text);
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
    system_prompt:
      "You are the coach's Instagram DM assistant. Be friendly, concise and human. Ask one clear question at a time. Keep replies short. Do not mention AI.",
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
    )
      allowed.instagram_handle = patch.instagram_handle;

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

app.post("/coach/api/config", requireCoach, async (req, res) => {
  try {
    const patch = req.body || {};
    const allowed = {};

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
  try {
    const { instagram_handle } = req.body || {};
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

    const base = cfg?.system_prompt || "";

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

      return safeJson(res, 200, { ok: true, system_prompt: stub, used_ai: false });
    }

    const messages = [
      {
        role: "system",
        content: [
          "You write system prompts for an Instagram DM assistant for a coach.",
          "Output ONLY the system prompt text. No quotes, no markdown.",
          "Make it practical and specific.",
          "No emojis by default. No em dashes or double hyphens.",
          "Avoid repetition and keep the conversation moving forward.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Coach Instagram handle: @${handle}`,
          "",
          "Goal: Create a strong system prompt for the coach's DM assistant.",
          "Constraints:",
          "- Keep it short but clear (8-14 lines).",
          "- UK tone, confident, not cringe.",
          "- 1-2 sentences per reply, end with ONE question.",
          "- No emojis by default. No em dashes or double hyphens.",
          "- Avoid repetition.",
          "- If asked about price: ask goal + current situation; don't invent prices.",
          "- If high intent: guide to booking link (but don't spam).",
          "",
          "If there is an existing prompt, improve it while keeping the intent:",
          base ? `EXISTING_PROMPT:\n${base}` : "EXISTING_PROMPT: (none)",
        ].join("\n"),
      },
    ];

    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.5,
      max_tokens: 350,
    });

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (!text) return safeJson(res, 500, { error: "failed to generate prompt" });

    return safeJson(res, 200, { ok: true, system_prompt: text, used_ai: true });
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
console.log("IG WEBHOOK messaging:", JSON.stringify(messaging, null, 2));
console.log("senderId:", senderId);
console.log("recipientId:", recipientId);    
const text = extractIgText(messaging);
    const isEcho = isIgEcho(messaging);

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
          const { data: newLead } = await supabase
            .from("leads")
            .insert({
              ig_psid: senderId,
              stage: "new",
            })
            .select()
            .single();

          lead = newLead;
        }

        await supabase.from("messages").insert({
          lead_id: lead.id,
          direction: isEcho ? "out" : "in",
          text,
          created_at: new Date().toISOString(),
        });

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
          historyMessages = await getLeadMessageHistory(lead.id, 10);
        } catch {}

        const thinkAboutIt = detectThinkAboutIt(text);

        const reply = await generateAiReply({
          cfg,
          lead,
          historyMessages,
          postCallMode: lead.call_completed,
          asksPrice: /price|cost|how much/i.test(text),
          highIntent: /ready|start|sign up|book/i.test(text),
          bookingUrl: cfg?.booking_url || null,
          thinkAboutIt,
        });

const igAccount = await getIgAccountByClientId(lead.client_id);

if (!igAccount?.page_access_token) {
  console.error("Missing Instagram access token for client:", lead.client_id);
  return;
}

const sendResp = await fetch(
  `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    igAccount.page_access_token
  )}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: reply },
    }),
  }
);

const sendData = await sendResp.json().catch(() => null);

console.log("SEND RESP OK:", sendResp.ok);
console.log("SEND DATA:", JSON.stringify(sendData, null, 2));

if (!sendResp.ok) {
  throw new Error(`Failed to send IG message: ${JSON.stringify(sendData)}`);
}        

        await supabase.from("messages").insert({
          lead_id: lead.id,
          direction: "out",
          text: reply,
          created_at: new Date().toISOString(),
        });
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
