/**
 * trial/routes.js — Self-serve trial flow (additive, separate from existing signup)
 *
 * Routes added:
 *   GET  /trial/admin                  — Admin UI for generating trial links
 *   GET  /admin/api/trial/links        — List trial links (admin protected)
 *   POST /admin/api/trial/generate     — Generate a new trial link (admin protected)
 *   GET  /start/:token                 — Public landing page
 *   POST /api/trial/checkout/:token    — Create Stripe checkout session + redirect
 *   GET  /trial/success                — Mark trial complete, redirect to set-password
 *
 * Wiring: index.js imports this router via `import trialRouter from './trial/routes.js'`
 * and mounts it with `app.use(trialRouter)`.
 *
 * New env vars needed (in addition to existing ones):
 *   STRIPE_TRIAL_WEBHOOK_SECRET  — only needed if you later wire up /webhook/stripe-trial
 *                                   in Stripe dashboard (optional for initial testing)
 */

import express from "express";
import { supabase } from "../supabaseClient.js";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Config (all read from existing env vars where possible) ─────────────────
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const DASHBOARD_JWT_SECRET  = process.env.DASHBOARD_JWT_SECRET;
const APP_PUBLIC_URL        = process.env.APP_PUBLIC_URL
                              || process.env.APP_BASE_URL
                              || "http://localhost:3000";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ── Admin middleware (mirrors requireAdmin in index.js) ─────────────────────
function requireAdmin(req, res, next) {
  const hdr   = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing admin token" });
  if (!DASHBOARD_JWT_SECRET) return res.status(500).json({ error: "dashboard not configured" });
  try {
    const decoded = jwt.verify(token, DASHBOARD_JWT_SECRET);
    if (!decoded || decoded.role !== "admin") return res.status(403).json({ error: "forbidden" });
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Serve the trial admin page (unprotected at route level — JS handles auth
// via localStorage.getItem('admin_token'), same as existing admin dashboard)
router.get("/trial/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// List all trial links
router.get("/admin/api/trial/links", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("trial_links")
      .select("id, token, price_amount, label, status, client_id, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ links: data || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Generate a new trial link
router.post("/admin/api/trial/generate", requireAdmin, async (req, res) => {
  try {
    const { label, price_amount } = req.body || {};
    const token = randomToken(12); // 24-char hex

    // Validate price_amount if provided — must be a positive integer (pence)
    const amount = price_amount != null ? Number(price_amount) : 3000;
    if (!Number.isInteger(amount) || amount < 100) {
      return res.status(400).json({ error: "price_amount must be an integer ≥ 100 pence" });
    }

    const { data, error } = await supabase
      .from("trial_links")
      .insert({
        token,
        price_amount: amount,
        label: label ? String(label).trim() : null,
        status: "unused",
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const url = `${APP_PUBLIC_URL}/start/${token}`;
    return res.json({ ok: true, url, token, link: data });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC LANDING PAGE — GET /start/:token
// ─────────────────────────────────────────────────────────────────────────────
router.get("/start/:token", async (req, res) => {
  const { token } = req.params;

  // Validate token server-side before serving the page
  const { data: trialLink, error } = await supabase
    .from("trial_links")
    .select("id, token, price_amount, label, status")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.warn("[trial] DB error on token lookup:", error.message);
    return res.status(500).send(errorPage("Something went wrong. Please try again or contact james@looped.ltd."));
  }

  if (!trialLink) {
    return res.status(404).send(errorPage(
      "This link isn't valid. It may have expired or been entered incorrectly. " +
      "Contact <a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a> for a new link."
    ));
  }

  if (trialLink.status === "completed") {
    return res.status(410).send(errorPage(
      "This trial link has already been used. " +
      "Contact <a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a> if you need help."
    ));
  }

  const monthlyAmount = `£${(trialLink.price_amount / 100).toFixed(0)}`;
  return res.send(landingPage(token, monthlyAmount));
});

// ─────────────────────────────────────────────────────────────────────────────
// CHECKOUT — POST /api/trial/checkout/:token
// Creates clients + payment_links rows then redirects to Stripe checkout
// ─────────────────────────────────────────────────────────────────────────────
router.post("/api/trial/checkout/:token", async (req, res) => {
  const { token } = req.params;

  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured on this server" });
    }

    // 1. Validate trial link
    const { data: trialLink, error: tlErr } = await supabase
      .from("trial_links")
      .select("id, token, price_amount, label, status, client_id")
      .eq("token", token)
      .maybeSingle();

    if (tlErr) return res.status(500).json({ error: "Database error" });
    if (!trialLink) return res.status(404).json({ error: "Trial link not found" });
    if (trialLink.status === "completed") {
      return res.status(409).json({ error: "This trial link has already been used" });
    }

    // 2. Get or create the client record
    // trial_links.client_id is set on first checkout attempt so a back-button
    // retry doesn't create a second clients row.
    let clientId = trialLink.client_id;

    if (!clientId) {
      const clientName = trialLink.label || "Trial Signup";

      // Create clients row
      const { data: newClient, error: clientErr } = await supabase
        .from("clients")
        .insert({ name: clientName, timezone: "Europe/London" })
        .select()
        .single();

      if (clientErr || !newClient) {
        console.error("[trial] failed to create client:", clientErr?.message);
        return res.status(500).json({ error: "Failed to create account" });
      }

      clientId = newClient.id;

      // Create client_configs row with the same defaults as the admin create endpoint
      const { error: cfgErr } = await supabase.from("client_configs").insert({
        client_id: clientId,
        stripe_subscription_status: null,
        system_prompt:
          "You are a helpful assistant that qualifies leads and books sales calls on behalf of this coach. " +
          "Keep replies short, casual and conversational. Ask one question at a time to understand the lead's " +
          "goals and situation before moving towards booking a call.",
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

      if (cfgErr) {
        console.error("[trial] failed to create client_configs:", cfgErr?.message);
        // Roll back the clients row and abort
        await supabase.from("clients").delete().eq("id", clientId);
        return res.status(500).json({ error: "Failed to configure account" });
      }

      // Persist client_id on the trial_links row so retries reuse it
      await supabase
        .from("trial_links")
        .update({ client_id: clientId })
        .eq("token", token);
    }

    // 3. Create a setup token in payment_links so the existing /set-password
    //    flow works exactly as it does for manually-created clients
    const setupToken = randomToken(24); // 48-char hex
    const { error: plErr } = await supabase.from("payment_links").insert({
      token: setupToken,
      client_id: clientId,
      email: null,
    });

    if (plErr) {
      console.error("[trial] failed to insert payment_links:", plErr?.message);
      return res.status(500).json({ error: "Failed to prepare onboarding" });
    }

    // 4. Create Stripe Checkout Session
    const monthlyPrice = trialLink.price_amount;
    const monthlyLabel = `£${(monthlyPrice / 100).toFixed(0)}/month after trial`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_collection: "always",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: "Looped — Instagram DM Automation",
              description: `7-day free trial, then ${monthlyLabel}`,
            },
            unit_amount: monthlyPrice,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 7,
      },
      // metadata must match what the existing /webhook/stripe handler expects
      metadata: {
        client_id: String(clientId),
        payment_token: setupToken,
        trial_token: token,
      },
      success_url: `${APP_PUBLIC_URL}/trial/success?trial_token=${encodeURIComponent(token)}&token=${encodeURIComponent(setupToken)}`,
      cancel_url: `${APP_PUBLIC_URL}/start/${token}`,
      billing_address_collection: "required",
      automatic_tax: { enabled: true },
    });

    console.log("[trial] Stripe session created", { clientId, sessionId: session.id, token });

    // 5. Redirect to Stripe Checkout
    return res.redirect(303, session.url);
  } catch (e) {
    console.error("[trial] checkout error:", e?.message || e);
    return res.status(500).json({ error: "Checkout failed — please try again" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS REDIRECT — GET /trial/success
// Stripe redirects here after a successful checkout.
// Marks the trial_links row as completed then hands off to the existing
// /set-password flow (which already handles creating coach credentials).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial/success", async (req, res) => {
  const { trial_token, token } = req.query;

  if (trial_token) {
    // Mark the trial link as completed (fire and forget — don't block the redirect)
    supabase
      .from("trial_links")
      .update({ status: "completed" })
      .eq("token", trial_token)
      .then(({ error }) => {
        if (error) console.warn("[trial] failed to mark trial_link completed:", error.message);
        else console.log("[trial] trial_link marked completed:", trial_token);
      });
  }

  if (!token) {
    // Shouldn't happen in normal flow — show a helpful message
    return res.send(errorPage(
      "Your payment was received but something went wrong with your onboarding link. " +
      "Please contact <a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a> " +
      "and we'll get you set up manually within a few minutes."
    ));
  }

  // Hand off to the existing set-password flow
  return res.redirect(302, `/set-password?token=${encodeURIComponent(token)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Looped</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border: 1px solid rgba(15,23,42,.1); border-radius: 16px; padding: 40px 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(15,23,42,.06); }
    .logo { font-weight: 900; font-size: 22px; color: #2d6bff; margin-bottom: 24px; }
    p { font-size: 15px; line-height: 1.6; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Looped</div>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

function landingPage(token, monthlyAmount) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Looped — Instagram DM Automation for Coaches</title>
  <meta name="description" content="Looped replies to your Instagram DMs in your voice, qualifies leads, and books them into calls — 24/7, hands-free." />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --primary: #2d6bff;
      --primary-dark: #1a52d4;
      --text: #0f172a;
      --muted: #64748b;
      --border: rgba(15,23,42,.1);
      --bg: #f8fafc;
      --card: #ffffff;
      --green: #027a48;
      --green-bg: #ecfdf3;
      --green-border: #a7f3d0;
    }

    html { scroll-behavior: smooth; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }

    /* ── NAV ── */
    nav { padding: 18px 24px; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid var(--border); background: #fff; }
    .logo { font-weight: 900; font-size: 22px; color: var(--primary); letter-spacing: -0.3px; }

    /* ── HERO ── */
    .hero { padding: 80px 24px 64px; text-align: center; max-width: 680px; margin: 0 auto; }
    .hero-tag { display: inline-block; background: #eff6ff; color: var(--primary); font-size: 12px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 5px 12px; border-radius: 999px; border: 1px solid #bfdbfe; margin-bottom: 20px; }
    .hero h1 { font-size: clamp(28px, 5vw, 48px); font-weight: 900; line-height: 1.15; letter-spacing: -0.5px; margin-bottom: 18px; }
    .hero h1 span { color: var(--primary); }
    .hero p { font-size: 17px; color: var(--muted); max-width: 540px; margin: 0 auto 32px; }
    .cta-btn { display: inline-block; background: var(--primary); color: #fff; font-size: 17px; font-weight: 800; padding: 16px 36px; border-radius: 12px; border: none; cursor: pointer; text-decoration: none; transition: background .15s, transform .1s; }
    .cta-btn:hover { background: var(--primary-dark); transform: translateY(-1px); }
    .cta-btn:active { transform: translateY(0); }
    .cta-btn.loading { opacity: .7; pointer-events: none; }
    .hero-sub { font-size: 13px; color: var(--muted); margin-top: 12px; }
    .err-msg { display: none; color: #b42318; font-size: 14px; margin-top: 14px; background: #fff5f5; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 14px; }

    /* ── SECTION ── */
    section { padding: 64px 24px; }
    .section-inner { max-width: 900px; margin: 0 auto; }
    .section-label { font-size: 12px; font-weight: 800; color: var(--primary); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 10px; }
    .section-heading { font-size: clamp(22px, 3.5vw, 32px); font-weight: 900; letter-spacing: -0.3px; margin-bottom: 14px; }
    .section-sub { font-size: 16px; color: var(--muted); max-width: 560px; }

    /* ── HOW IT WORKS ── */
    .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-top: 40px; }
    .step { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
    .step-num { width: 36px; height: 36px; border-radius: 10px; background: #eff6ff; color: var(--primary); font-weight: 900; font-size: 16px; display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
    .step h3 { font-size: 15px; font-weight: 800; margin-bottom: 6px; }
    .step p { font-size: 14px; color: var(--muted); line-height: 1.6; }

    /* ── FEATURES ── */
    .features-bg { background: #fff; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 40px; }
    .feature { display: flex; gap: 14px; align-items: flex-start; }
    .feature-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
    .feature h4 { font-size: 14px; font-weight: 800; margin-bottom: 4px; }
    .feature p { font-size: 14px; color: var(--muted); line-height: 1.5; }

    /* ── PRICING ── */
    .pricing-card { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 36px; max-width: 480px; box-shadow: 0 4px 24px rgba(15,23,42,.06); margin-top: 40px; }
    .price-amount { font-size: 52px; font-weight: 900; letter-spacing: -1px; color: var(--text); line-height: 1; }
    .price-amount sup { font-size: 22px; font-weight: 700; vertical-align: top; margin-top: 10px; display: inline-block; }
    .price-period { font-size: 16px; color: var(--muted); margin-top: 4px; margin-bottom: 20px; }
    .price-list { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }
    .price-list li { font-size: 14px; color: var(--muted); display: flex; align-items: center; gap: 10px; }
    .price-list li::before { content: "✓"; color: var(--primary); font-weight: 900; font-size: 15px; flex-shrink: 0; }
    .vs-note { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px 16px; font-size: 13px; color: #166534; line-height: 1.5; }

    /* ── GUARANTEE ── */
    .guarantee-bg { background: var(--green-bg); border-top: 1px solid var(--green-border); border-bottom: 1px solid var(--green-border); }
    .guarantee-card { background: var(--card); border: 2px solid var(--green-border); border-radius: 20px; padding: 36px; max-width: 600px; margin-top: 0; }
    .guarantee-icon { font-size: 36px; margin-bottom: 14px; }
    .guarantee-card h3 { font-size: 22px; font-weight: 900; color: var(--green); margin-bottom: 10px; }
    .guarantee-card p { font-size: 15px; color: var(--muted); line-height: 1.6; }

    /* ── FINAL CTA ── */
    .final-cta { text-align: center; padding: 80px 24px; }
    .final-cta h2 { font-size: clamp(22px, 3.5vw, 34px); font-weight: 900; letter-spacing: -0.3px; margin-bottom: 12px; }
    .final-cta p { color: var(--muted); font-size: 16px; margin-bottom: 32px; }

    /* ── FOOTER ── */
    footer { padding: 24px; text-align: center; font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); }

    @media (max-width: 600px) {
      .hero { padding: 56px 20px 48px; }
      .pricing-card { padding: 24px 20px; }
      .guarantee-card { padding: 24px 20px; }
    }
  </style>
</head>
<body>

<nav>
  <div class="logo">Looped</div>
</nav>

<!-- HERO -->
<div class="hero">
  <div class="hero-tag">Instagram Automation for Coaches</div>
  <h1>Your DMs, <span>automated</span>.<br>Your leads, booked.</h1>
  <p>Looped replies to your Instagram DMs in your voice, qualifies every lead, handles objections, and pushes them to book a call — around the clock, without you lifting a finger.</p>
  <form id="startForm" onsubmit="startTrial(event)">
    <button type="submit" class="cta-btn" id="startBtn">Start your 7-day free trial</button>
    <div class="hero-sub">No charge today &mdash; card required &mdash; ${monthlyAmount}/month after trial</div>
    <div class="err-msg" id="errMsg"></div>
  </form>
</div>

<!-- HOW IT WORKS -->
<section>
  <div class="section-inner">
    <div class="section-label">How it works</div>
    <div class="section-heading">Set up in minutes. Works while you sleep.</div>
    <p class="section-sub">Connect your Instagram, fill in a few details about your offer and your voice, and Looped handles the rest.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <h3>Connect your Instagram</h3>
        <p>One-click Instagram connection via the dashboard. No technical setup required.</p>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <h3>Train it on your voice</h3>
        <p>Paste in a few real DMs showing how you handle common questions. Looped learns your tone exactly.</p>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <h3>Watch it qualify and book</h3>
        <p>Looped replies to every DM, story reply, and comment keyword — qualifying leads and driving them to book your discovery call.</p>
      </div>
    </div>
  </div>
</section>

<!-- FEATURES -->
<section class="features-bg">
  <div class="section-inner">
    <div class="section-label">What you get</div>
    <div class="section-heading">Everything your DMs need</div>
    <div class="features-grid" style="margin-top:40px;">
      <div class="feature">
        <div class="feature-icon">💬</div>
        <div>
          <h4>DM replies in your voice</h4>
          <p>GPT-4o-mini trained on your real messages. Sounds like you, not like a bot.</p>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">📖</div>
        <div>
          <h4>Story reply automation</h4>
          <p>Someone reacts to your story? Looped starts a qualifying conversation automatically.</p>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">💡</div>
        <div>
          <h4>Comment keyword DMs</h4>
          <p>Comment a keyword on your post and get an instant DM — great for lead magnets and offers.</p>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">📅</div>
        <div>
          <h4>Books calls for you</h4>
          <p>Looped handles objections, builds trust, and drives every warm lead to your booking link.</p>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">⏰</div>
        <div>
          <h4>24/7 response time</h4>
          <p>Replies in seconds at any hour. No more leads going cold because you were busy.</p>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">🎯</div>
        <div>
          <h4>Lead qualification built in</h4>
          <p>Asks the right questions to filter out tyre-kickers and only push serious leads to a call.</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- PRICING -->
<section>
  <div class="section-inner">
    <div class="section-label">Pricing</div>
    <div class="section-heading">One flat rate. No surprises.</div>
    <p class="section-sub">No per-call fees. No percentage of your revenue. Just a simple monthly subscription.</p>
    <div class="pricing-card">
      <div class="price-amount"><sup>£</sup>${monthlyAmount.replace("£", "")}</div>
      <div class="price-period">per month &mdash; cancel any time</div>
      <ul class="price-list">
        <li>Unlimited DM replies</li>
        <li>Story reply automation</li>
        <li>Comment keyword triggers</li>
        <li>GPT-4o-mini powered conversations</li>
        <li>Full dashboard with lead activity feed</li>
        <li>7-day free trial included</li>
      </ul>
      <div class="vs-note">
        Most competitors charge <strong>£20–100 per booked call</strong> or take a percentage of every sale.
        Looped charges a flat rate — so the more calls you book, the better value it gets.
      </div>
    </div>
  </div>
</section>

<!-- GUARANTEE -->
<section class="guarantee-bg">
  <div class="section-inner">
    <div class="guarantee-card">
      <div class="guarantee-icon">🛡️</div>
      <h3>The 3-call guarantee</h3>
      <p>Don't get 3 qualified calls booked in your first paid month? That month is on us. No questions, no hoops to jump through.</p>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<div class="final-cta">
  <h2>Ready to stop leaving DMs on read?</h2>
  <p>Start your 7-day free trial — your card won't be charged until day 8.</p>
  <button class="cta-btn" onclick="startTrial(event)">Start your free trial now</button>
  <div class="hero-sub" style="margin-top:12px;">Card required upfront &mdash; cancel any time &mdash; ${monthlyAmount}/month after trial</div>
</div>

<footer>
  &copy; ${new Date().getFullYear()} Looped &middot; <a href="mailto:james@looped.ltd" style="color:var(--muted);">james@looped.ltd</a>
</footer>

<script>
  async function startTrial(e) {
    if (e && e.preventDefault) e.preventDefault();

    const btn = document.getElementById('startBtn');
    const errEl = document.getElementById('errMsg');
    if (errEl) errEl.style.display = 'none';
    if (btn) { btn.textContent = 'Redirecting to checkout…'; btn.classList.add('loading'); }

    try {
      // POST to the checkout endpoint — server creates Stripe session and
      // responds with a 303 redirect to Stripe Checkout
      const res = await fetch('/api/trial/checkout/${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.redirected) {
        window.location.href = res.url;
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }

      // In case redirect didn't auto-follow
      const data = await res.json().catch(() => ({}));
      if (data.url) { window.location.href = data.url; return; }

      throw new Error('Unexpected response from server.');
    } catch (err) {
      if (btn) { btn.textContent = 'Start your 7-day free trial'; btn.classList.remove('loading'); }
      if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
    }
  }
</script>

</body>
</html>`;
}

export default router;
