/**
 * trial/routes.js — Self-serve trial flow (additive, separate from existing signup)
 *
 * Routes:
 *   GET  /start/:token                 — Public landing page
 *   POST /api/trial/checkout/:token    — Create Stripe checkout session
 *   GET  /trial/success                — Verify payment, redirect to set-password
 *
 * Admin routes (list links, generate links) live in index.js using the
 * existing requireAdmin middleware.
 */

import express from "express";
import { supabase } from "../supabaseClient.js";
import Stripe from "stripe";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Config ──────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// APP_BASE_URL = pay.looped.ltd — used for landing page URLs and cancel URL
const APP_BASE_URL      = process.env.APP_BASE_URL   || "http://localhost:3000";
// APP_PUBLIC_URL = app.looped.ltd — used for success_url (same as existing payment link flow)
const APP_PUBLIC_URL    = process.env.APP_PUBLIC_URL || APP_BASE_URL;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

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
// Creates a payment_links row then redirects to Stripe checkout
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

    // 2. Resolve client_id — must be set on the trial_links row (admin sets it
    //    when generating the link via the dashboard).
    const clientId = trialLink.client_id;
    if (!clientId) {
      console.error("[trial] trial_links row has no client_id:", token);
      return res.status(400).json({ error: "This trial link is not yet assigned to an account. Please contact james@looped.ltd." });
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
      // {CHECKOUT_SESSION_ID} is a Stripe placeholder — it's substituted with the real
      // session ID before the redirect, so /trial/success can verify the session via API.
      // payment_token is NOT in the URL — we read it from verified session metadata instead.
      success_url: `${APP_PUBLIC_URL}/trial/success?session_id={CHECKOUT_SESSION_ID}&trial_token=${encodeURIComponent(token)}`,
      cancel_url: `${APP_BASE_URL}/start/${token}`,
      billing_address_collection: "required",
      automatic_tax: { enabled: true },
    });

    console.log("[trial] Stripe session created", { clientId, sessionId: session.id, token });

    // 5. Return the Stripe Checkout URL as JSON.
    // The client does window.location.href = data.url — we don't use a server-side
    // redirect because fetch() follows cross-origin redirects and hits a CORS block
    // when it tries to load stripe.com, which prevents the navigation from happening.
    return res.json({ url: session.url });
  } catch (e) {
    console.error("[trial] checkout error:", e?.message || e);
    return res.status(500).json({ error: "Checkout failed — please try again" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS REDIRECT — GET /trial/success
// Stripe redirects here after a successful checkout.
//
// Security model:
//   - Retrieves the Stripe session by ID and confirms session.status === "complete"
//     before doing anything — query params alone are not trusted.
//   - Cross-checks session.metadata.trial_token against the trial_token param
//     so a valid session ID can't be swapped in for a different trial link.
//   - Reads the setup token (payment_token) from verified session metadata,
//     never from the URL.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial/success", async (req, res) => {
  const { session_id, trial_token } = req.query;

  if (!session_id) {
    return res.send(errorPage(
      "Payment confirmation is missing. If you completed checkout, please contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a> " +
      "and we'll get you set up manually."
    ));
  }

  if (!stripe) {
    console.error("[trial/success] Stripe not configured — cannot verify session");
    return res.send(errorPage(
      "Payment verification is unavailable right now. Please contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a>."
    ));
  }

  // 1. Retrieve and verify the session from Stripe
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch (e) {
    console.error("[trial/success] failed to retrieve Stripe session:", session_id, e?.message);
    return res.send(errorPage(
      "We could not verify your payment. Please contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a>."
    ));
  }

  // 2. Confirm the session is actually complete
  if (session.status !== "complete") {
    console.warn("[trial/success] session not complete:", session.status, session_id);
    return res.send(errorPage(
      "Your payment is still processing. Please wait a moment and check your email, or contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a>."
    ));
  }

  // 3. Cross-check trial_token in URL against what's in session metadata
  //    so a real completed session can't be reused to unlock a different trial link
  const metaTrialToken = session.metadata?.trial_token;
  if (!metaTrialToken || metaTrialToken !== trial_token) {
    console.warn("[trial/success] trial_token mismatch", {
      fromUrl: trial_token,
      fromMeta: metaTrialToken,
      sessionId: session_id,
    });
    return res.send(errorPage(
      "Payment verification failed. Please contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a>."
    ));
  }

  // 4. Read setup token from verified session metadata — never from the URL
  const setupToken = session.metadata?.payment_token;
  if (!setupToken) {
    console.error("[trial/success] payment_token missing from session metadata", session_id);
    return res.send(errorPage(
      "Your payment was received but your onboarding link is missing. Please contact " +
      "<a href=\"mailto:james@looped.ltd\" style=\"color:#2d6bff;\">james@looped.ltd</a>."
    ));
  }

  // 5. Mark trial link as completed (async, doesn't block the redirect)
  supabase
    .from("trial_links")
    .update({ status: "completed" })
    .eq("token", trial_token)
    .then(({ error }) => {
      if (error) console.warn("[trial/success] failed to mark trial_link completed:", error.message);
      else console.log("[trial/success] trial_link marked completed:", trial_token);
    });

  console.log("[trial/success] verified and redirecting to set-password", { session_id, trial_token });

  // 6. Hand off to the existing set-password flow
  return res.redirect(302, `/set-password?token=${encodeURIComponent(setupToken)}`);
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
  <title>Looped | Instagram DM Automation for Coaches</title>
  <meta name="description" content="Looped replies to your Instagram DMs in your voice, qualifies leads, and books them into calls. 24/7, hands-free." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --primary: #2d6bff;
      --primary-dark: #1a52d4;
      --text: #0f172a;
      --muted: rgba(15,23,42,0.55);
      --border: rgba(15,23,42,0.10);
      --border2: rgba(15,23,42,0.14);
      --bg: #f7f8fb;
      --panel: #ffffff;
      --shadow: 0 10px 30px rgba(15,23,42,0.06);
      --shadow-lg: 0 24px 60px rgba(15,23,42,0.10);
      --ok: #027a48;
      --ok-bg: rgba(2,122,72,0.08);
      --ok-border: rgba(2,122,72,0.18);
    }

    html { scroll-behavior: smooth; }
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }

    /* NAV */
    nav { height: 60px; padding: 0 28px; display: flex; align-items: center; background: rgba(255,255,255,0.72); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; transition: background 0.25s ease, box-shadow 0.25s ease; }
    nav.nav-scrolled { background: rgba(255,255,255,0.96); box-shadow: 0 2px 20px rgba(15,23,42,0.07); }
    .logo { font-weight: 900; font-size: 17px; color: var(--primary); letter-spacing: -0.2px; }

    /* HERO SECTION wrapper for gradient */
    .hero-section { position: relative; overflow: hidden; }
    /* .hero-gradient background is set entirely by JS (cursor-tracking + ambient drift) */
    .hero-gradient { position: absolute; inset: -30%; pointer-events: none; z-index: 0; }

    /* HERO */
    .hero { padding: 64px 32px 52px; text-align: center; max-width: 1000px; margin: 0 auto; position: relative; z-index: 1; }
    .hero-badge { display: inline-flex; align-items: center; background: rgba(45,107,255,0.07); border: 1px solid rgba(45,107,255,0.18); color: var(--primary); font-size: 11px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; padding: 6px 14px; border-radius: 999px; margin-bottom: 28px; }
    .hero h1 { font-size: clamp(32px, 5vw, 52px); font-weight: 900; line-height: 1.1; letter-spacing: -1.5px; margin-bottom: 24px; color: var(--text); }
    .hero h1 em { font-style: normal; color: var(--primary); }
    .hero-lead { font-size: 18px; color: var(--muted); max-width: 620px; margin: 0 auto 36px; line-height: 1.65; }
    .cta-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .cta-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--primary); color: #fff; font-size: 16px; font-weight: 800; padding: 17px 42px; border-radius: 12px; border: none; cursor: pointer; letter-spacing: 0px; box-shadow: 0 4px 20px rgba(45,107,255,0.30); transition: box-shadow .15s, transform .1s, background .15s; font-family: inherit; }
    .cta-btn:hover { background: var(--primary-dark); box-shadow: 0 8px 32px rgba(45,107,255,0.38); transform: translateY(-1px); }
    .cta-btn:active { transform: translateY(0); box-shadow: 0 3px 12px rgba(45,107,255,0.22); }
    .cta-btn.loading { opacity: .7; pointer-events: none; }
    .hero-meta { font-size: 13px; color: var(--muted); }
    .err-msg { display: none; color: #b42318; font-size: 13px; background: #fff5f5; border: 1px solid rgba(180,35,24,0.18); border-radius: 10px; padding: 11px 16px; max-width: 420px; }

    /* DM DEMO */
    .dm-demo { margin: 48px auto 0; max-width: 320px; }
    .dm-phone { background: var(--panel); border: 1px solid var(--border); border-radius: 20px; box-shadow: var(--shadow-lg); overflow: hidden; }
    .dm-header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); background: rgba(15,23,42,0.02); }
    .dm-avatar { width: 32px; height: 32px; border-radius: 50%; background: rgba(45,107,255,0.12); border: 1px solid rgba(45,107,255,0.20); flex-shrink: 0; }
    .dm-contact-name { font-size: 13px; font-weight: 800; color: var(--text); line-height: 1.2; }
    .dm-contact-status { font-size: 11px; color: var(--ok); font-weight: 600; }
    .dm-messages { padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 8px; min-height: 100px; max-height: 200px; overflow-y: auto; }
    .dm-bubble { max-width: 88%; padding: 9px 13px; border-radius: 16px; font-size: 13px; line-height: 1.5; }
    .dm-bubble.incoming { align-self: flex-start; background: rgba(15,23,42,0.06); color: var(--text); border-bottom-left-radius: 4px; }
    .dm-bubble.outgoing { align-self: flex-end; background: var(--primary); color: #fff; border-bottom-right-radius: 4px; text-align: left; word-break: break-word; }
    .dm-typing { display: none; align-self: flex-start; gap: 5px; padding: 11px 14px; background: rgba(15,23,42,0.06); border-radius: 16px; border-bottom-left-radius: 4px; align-items: center; }
    .dm-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(15,23,42,0.30); animation: dmPulse 1.3s ease-in-out infinite; }
    .dm-dot:nth-child(2) { animation-delay: 0.22s; }
    .dm-dot:nth-child(3) { animation-delay: 0.44s; }
    @keyframes dmPulse { 0%,100% { opacity: 0.3; transform: scale(0.75); } 50% { opacity: 1; transform: scale(1); } }
    .dm-booked { display: flex; align-items: center; justify-content: flex-end; gap: 6px; font-size: 12px; font-weight: 700; color: var(--ok); opacity: 0; transition: opacity 0.45s ease; padding-right: 2px; }
    .dm-booked-check { width: 16px; height: 16px; border-radius: 50%; background: var(--ok-bg); border: 1px solid var(--ok-border); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .dm-booked-check::after { content: ''; display: block; width: 4px; height: 7px; border-right: 1.5px solid var(--ok); border-bottom: 1.5px solid var(--ok); transform: rotate(45deg) translate(-0.5px, -1px); }
    .dm-input-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--border); }
    .dm-input { flex: 1; border: 1px solid var(--border); border-radius: 20px; padding: 8px 14px; font-size: 13px; font-family: inherit; color: var(--text); background: rgba(15,23,42,0.03); outline: none; transition: border-color 0.15s; }
    .dm-input:focus { border-color: var(--primary); }
    .dm-input:disabled { opacity: 0.5; }
    .dm-send-btn { width: 32px; height: 32px; border-radius: 50%; background: var(--primary); border: none; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s, transform 0.1s; }
    .dm-send-btn:hover:not(:disabled) { background: var(--primary-dark); transform: scale(1.05); }
    .dm-send-btn:disabled { opacity: 0.4; cursor: default; }
    .dm-try-again { display: none; padding: 8px 14px 12px; text-align: center; }
    .dm-try-again-btn { background: none; border: none; color: var(--primary); font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .dm-try-again-btn:hover { color: var(--primary-dark); }

    /* STATS */
    .stats-section { padding: 0 32px 48px; }
    .stats-inner { max-width: 720px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); background: var(--panel); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden; }
    .stat-item { padding: 28px 16px; text-align: center; border-right: 1px solid var(--border); }
    .stat-item:last-child { border-right: none; }
    .stat-num { font-size: 30px; font-weight: 900; color: var(--primary); letter-spacing: -0.5px; line-height: 1; display: block; }
    .stat-label { font-size: 12px; color: var(--muted); font-weight: 600; margin-top: 5px; line-height: 1.35; }

    /* SECTIONS */
    .section { padding: 56px 32px; }
    .section-inner { max-width: 1080px; margin: 0 auto; }
    .section-label { font-size: 11px; font-weight: 800; color: var(--primary); text-transform: uppercase; letter-spacing: .7px; margin-bottom: 12px; }
    .section-heading { font-size: clamp(22px, 3vw, 34px); font-weight: 900; letter-spacing: -0.4px; margin-bottom: 16px; line-height: 1.15; }
    .section-sub { font-size: 16px; color: var(--muted); max-width: 640px; line-height: 1.65; }

    /* HOW IT WORKS */
    .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 44px; }
    .step { background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 28px 24px; box-shadow: var(--shadow); transition: transform 0.22s ease, box-shadow 0.22s ease; }
    .step:hover { transform: translateY(-8px); box-shadow: 0 24px 52px rgba(15,23,42,0.14); }
    .step-num { width: 32px; height: 32px; border-radius: 10px; background: rgba(45,107,255,0.08); border: 1px solid rgba(45,107,255,0.15); color: var(--primary); font-weight: 900; font-size: 13px; display: flex; align-items: center; justify-content: center; margin-bottom: 18px; }
    .step h3 { font-size: 15px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.1px; }
    .step p { font-size: 14px; color: var(--muted); line-height: 1.65; }

    /* FEATURES */
    .features-wrap { background: var(--panel); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 32px; margin-top: 44px; }
    .feature { display: flex; flex-direction: column; gap: 8px; transition: transform 0.22s ease; }
    .feature:hover { transform: translateY(-5px); }
    .feature-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); opacity: 0.6; margin-bottom: 2px; }
    .feature h4 { font-size: 14px; font-weight: 800; letter-spacing: 0px; }
    .feature p { font-size: 14px; color: var(--muted); line-height: 1.65; }

    /* PRICING */
    .pricing-card { background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 40px; max-width: 480px; box-shadow: var(--shadow-lg); margin-top: 44px; transition: transform 0.22s ease, box-shadow 0.22s ease; }
    .pricing-card:hover { transform: translateY(-8px); box-shadow: 0 36px 80px rgba(15,23,42,0.18); }
    .price-row { display: flex; align-items: flex-start; line-height: 1; margin-bottom: 8px; }
    .price-sym { font-size: 26px; font-weight: 800; color: var(--text); padding-top: 10px; margin-right: 2px; }
    .price-num { font-size: 72px; font-weight: 900; letter-spacing: -2px; color: var(--text); }
    .price-period { font-size: 15px; color: var(--muted); margin-bottom: 28px; }
    .price-list { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
    .price-list li { font-size: 14px; color: var(--text); display: flex; align-items: center; gap: 10px; }
    .price-list li::before { content: ""; display: inline-block; width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%; background: rgba(45,107,255,0.09); border: 1px solid rgba(45,107,255,0.20); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6l2.2 2.2L9.5 3.8' stroke='%232d6bff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: center; }
    .vs-note { background: rgba(45,107,255,0.05); border: 1px solid rgba(45,107,255,0.12); border-radius: 12px; padding: 16px 18px; font-size: 13px; color: var(--muted); line-height: 1.65; }
    .vs-note strong { color: var(--text); font-weight: 700; }

    /* GUARANTEE */
    .guarantee-wrap { background: var(--ok-bg); border-top: 1px solid var(--ok-border); border-bottom: 1px solid var(--ok-border); }
    .guarantee-card { background: var(--panel); border: 1px solid var(--ok-border); border-radius: 20px; padding: 40px; max-width: 700px; box-shadow: var(--shadow); transition: transform 0.22s ease, box-shadow 0.22s ease; }
    .guarantee-card:hover { transform: translateY(-8px); box-shadow: 0 24px 52px rgba(15,23,42,0.14); }
    .guarantee-eyebrow { font-size: 11px; font-weight: 800; color: var(--ok); text-transform: uppercase; letter-spacing: .7px; margin-bottom: 12px; }
    .guarantee-card h3 { font-size: 22px; font-weight: 900; color: var(--ok); margin-bottom: 12px; letter-spacing: -0.3px; }
    .guarantee-card p { font-size: 15px; color: var(--muted); line-height: 1.7; }

    /* FINAL CTA */
    .final-cta { text-align: center; padding: 68px 32px 60px; }
    .final-cta h2 { font-size: clamp(24px, 3vw, 36px); font-weight: 900; letter-spacing: -0.5px; margin-bottom: 14px; line-height: 1.1; }
    .final-cta .final-sub { color: var(--muted); font-size: 16px; margin-bottom: 36px; }

    /* FOOTER */
    footer { padding: 28px 24px; text-align: center; font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); }
    footer a { color: var(--muted); text-decoration: none; }
    footer a:hover { color: var(--text); }

    /* SCROLL REVEAL */
    .reveal { opacity: 0; transform: translateY(22px); transition: opacity 0.55s ease, transform 0.55s ease; }
    .reveal.revealed { opacity: 1; transform: translateY(0); }

    @media (max-width: 600px) {
      .hero { padding: 44px 20px 40px; }
      .hero h1 { letter-spacing: -1px; }
      .section { padding: 40px 20px; }
      .stats-section { padding: 0 20px 36px; }
      .pricing-card { padding: 28px 22px; }
      .guarantee-card { padding: 28px 22px; }
      .final-cta { padding: 48px 20px 44px; }
      .stats-inner { grid-template-columns: 1fr; }
      .stat-item { border-right: none; border-bottom: 1px solid var(--border); }
      .stat-item:last-child { border-bottom: none; }
    }
  </style>
</head>
<body>

<nav id="mainNav">
  <div class="logo">Looped</div>
</nav>

<!-- HERO -->
<div class="hero-section">
  <div class="hero-gradient"></div>
  <div class="hero">
    <div class="hero-badge">Instagram Automation for Coaches</div>
    <h1>Keep people <em>in the loop.</em></h1>
    <p class="hero-lead">Replies to every DM, qualifies the lead, and books the call. Automatically.</p>
    <form id="startForm" onsubmit="startTrial(event)" style="display:contents;">
      <div class="cta-wrap">
        <button type="submit" class="cta-btn" id="startBtn">Start your 7-day free trial</button>
        <p class="hero-meta">No charge today. Card required. ${monthlyAmount}/month after trial.</p>
        <div class="err-msg" id="errMsg"></div>
      </div>
    </form>

    <!-- INTERACTIVE DM DEMO -->
    <div class="dm-demo">
      <div class="dm-phone">
        <div class="dm-header">
          <div class="dm-avatar"></div>
          <div>
            <div class="dm-contact-name">Looped</div>
            <div class="dm-contact-status">Active now</div>
          </div>
        </div>
        <div class="dm-messages" id="dm-messages">
          <div class="dm-booked" id="dm-booked">
            <span class="dm-booked-check"></span>
            Call booked
          </div>
        </div>
        <div class="dm-input-row" id="dm-input-row">
          <input class="dm-input" id="dm-input" type="text" placeholder="Type a message..." maxlength="120" autocomplete="off" />
          <button class="dm-send-btn" id="dm-send-btn" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="dm-try-again" id="dm-try-again">
          <button class="dm-try-again-btn" id="dm-try-again-btn">Try again</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- STATS -->
<div class="stats-section">
  <div class="stats-inner" id="statsSection">
    <div class="stat-item">
      <span class="stat-num" id="stat-dms">0+</span>
      <div class="stat-label">DMs replied to</div>
    </div>
    <div class="stat-item">
      <span class="stat-num" id="stat-response">0s</span>
      <div class="stat-label">Avg response time</div>
    </div>
    <div class="stat-item">
      <span class="stat-num" id="stat-calls">0+</span>
      <div class="stat-label">Calls booked</div>
    </div>
  </div>
</div>

<!-- HOW IT WORKS -->
<div class="section">
  <div class="section-inner">
    <div class="section-intro reveal">
      <div class="section-label">How it works</div>
      <div class="section-heading">Set up in minutes. Works while you sleep.</div>
      <p class="section-sub">Connect your Instagram, fill in a few details about your offer and your voice, and Looped handles the rest.</p>
    </div>
    <div class="steps">
      <div class="step reveal" data-delay="0">
        <div class="step-num">1</div>
        <h3>Connect your Instagram</h3>
        <p>One-click Instagram connection via the dashboard. No technical setup required.</p>
      </div>
      <div class="step reveal" data-delay="120">
        <div class="step-num">2</div>
        <h3>Train it on your voice</h3>
        <p>Paste in a few real DMs showing how you handle common questions. Looped learns your tone exactly.</p>
      </div>
      <div class="step reveal" data-delay="240">
        <div class="step-num">3</div>
        <h3>Watch it qualify and book</h3>
        <p>Looped replies to every DM, story reply, and comment keyword, qualifying leads and booking them into your discovery call.</p>
      </div>
    </div>
  </div>
</div>

<!-- FEATURES -->
<div class="section features-wrap">
  <div class="section-inner">
    <div class="section-intro reveal">
      <div class="section-label">What you get</div>
      <div class="section-heading">Everything your DMs need.</div>
    </div>
    <div class="features-grid">
      <div class="feature reveal" data-delay="0">
        <div class="feature-dot"></div>
        <h4>DM replies in your voice</h4>
        <p>GPT-4o-mini trained on your real messages. Sounds like you, not like a bot.</p>
      </div>
      <div class="feature reveal" data-delay="80">
        <div class="feature-dot"></div>
        <h4>Story reply automation</h4>
        <p>Someone reacts to your story? Looped starts a qualifying conversation automatically.</p>
      </div>
      <div class="feature reveal" data-delay="160">
        <div class="feature-dot"></div>
        <h4>Comment keyword DMs</h4>
        <p>Comment a keyword on your post and get an instant DM. Perfect for lead magnets and offers.</p>
      </div>
      <div class="feature reveal" data-delay="0">
        <div class="feature-dot"></div>
        <h4>Books calls for you</h4>
        <p>Looped handles objections, builds trust, and drives every warm lead to your booking link.</p>
      </div>
      <div class="feature reveal" data-delay="80">
        <div class="feature-dot"></div>
        <h4>24/7 response time</h4>
        <p>Replies in seconds at any hour. No more leads going cold because you were busy.</p>
      </div>
      <div class="feature reveal" data-delay="160">
        <div class="feature-dot"></div>
        <h4>Lead qualification built in</h4>
        <p>Asks the right questions to filter out tyre-kickers and only push serious leads to a call.</p>
      </div>
    </div>
  </div>
</div>

<!-- PRICING -->
<div class="section">
  <div class="section-inner">
    <div class="section-intro reveal">
      <div class="section-label">Pricing</div>
      <div class="section-heading">One flat rate. No surprises.</div>
      <p class="section-sub">No per-call fees. No percentage of your revenue. Just a simple monthly subscription.</p>
    </div>
    <div class="pricing-card reveal">
      <div class="price-row">
        <span class="price-sym">£</span>
        <span class="price-num">${monthlyAmount.replace("£", "")}</span>
      </div>
      <div class="price-period">per month, cancel any time</div>
      <ul class="price-list">
        <li>Unlimited DM replies</li>
        <li>Story reply automation</li>
        <li>Comment keyword triggers</li>
        <li>GPT-4o-mini powered conversations</li>
        <li>Full dashboard with lead activity feed</li>
        <li>7-day free trial included</li>
      </ul>
      <div class="vs-note">
        Most competitors charge <strong>£20 to £100 per booked call</strong> or take a percentage of every sale.
        Looped charges a flat rate, so the more calls you book, the better the value.
      </div>
    </div>
  </div>
</div>

<!-- GUARANTEE -->
<div class="section guarantee-wrap">
  <div class="section-inner">
    <div class="guarantee-card reveal">
      <div class="guarantee-eyebrow">Our guarantee</div>
      <h3>The 3-call guarantee</h3>
      <p>Don't get 3 qualified calls booked in your first paid month? That month is on us. No questions, no hoops to jump through.</p>
    </div>
  </div>
</div>

<!-- FINAL CTA -->
<div class="final-cta reveal">
  <h2>Ready to stop leaving DMs on read?</h2>
  <p class="final-sub">Start your 7-day free trial. Your card won't be charged until day 8.</p>
  <div class="cta-wrap">
    <button class="cta-btn" onclick="startTrial(event)">Start your free trial now</button>
    <p class="hero-meta">Card required upfront. Cancel any time. ${monthlyAmount}/month after trial.</p>
  </div>
</div>

<footer>
  &copy; ${new Date().getFullYear()} Looped &middot; <a href="mailto:james@looped.ltd">james@looped.ltd</a>
</footer>

<!-- ═══════════════════════════════════════════════════════════════════
     ANIMATION SCRIPT — visual polish only, completely separate from
     the checkout / startTrial logic below.
     Each sub-function is wrapped in try/catch so a bug in one cannot
     prevent the others from running.
     ═══════════════════════════════════════════════════════════════════ -->
<script>
(function () {
  'use strict';

  // ── 1. NAV SCROLL BLUR ──────────────────────────────────────────────────────
  try {
    var nav = document.getElementById('mainNav');
    if (nav) {
      window.addEventListener('scroll', function () {
        nav.classList.toggle('nav-scrolled', window.scrollY > 40);
      }, { passive: true });
    }
  } catch (e) { console.warn('[looped] nav scroll error:', e); }

  // ── 2. HERO GRADIENT — cursor-following with lerp + ambient drift ────────────
  // Background is set 100% via JS so opacity values are visible and the glow
  // actually moves. CSS has no animation or background on .hero-gradient.
  try {
    var gradEl   = document.querySelector('.hero-gradient');
    var heroSect = document.querySelector('.hero-section');
    if (gradEl) {
      var cx = 35, cy = 42;   // current lerped position (%)
      var tx = 35, ty = 42;   // target (mouse or ambient)
      var driftT  = 0;
      var hasMouse = false;

      if (heroSect) {
        heroSect.addEventListener('mousemove', function (e) {
          var r = heroSect.getBoundingClientRect();
          tx = ((e.clientX - r.left) / r.width)  * 100;
          ty = ((e.clientY - r.top)  / r.height) * 100;
          hasMouse = true;
        }, { passive: true });
        heroSect.addEventListener('mouseleave', function () { hasMouse = false; }, { passive: true });
      }

      function lerp(a, b, t) { return a + (b - a) * t; }

      function tickGradient() {
        driftT += 0.004;
        // Ambient sine drift when no mouse; flat when mouse is present
        var ambX = hasMouse ? 0 : Math.sin(driftT * 1.3) * 14;
        var ambY = hasMouse ? 0 : Math.cos(driftT * 0.9) * 9;
        var speed = hasMouse ? 0.07 : 0.025;

        cx = lerp(cx, tx + ambX, speed);
        cy = lerp(cy, ty + ambY, speed);

        var x1 = cx.toFixed(1), y1 = cy.toFixed(1);
        // Secondary glow drifts opposite corner
        var x2 = (100 - cx * 0.55).toFixed(1);
        var y2 = (cy  *  0.55 + 32).toFixed(1);

        gradEl.style.background =
          'radial-gradient(ellipse 72% 65% at ' + x1 + '% ' + y1 + '%, rgba(45,107,255,0.24) 0%, transparent 58%),' +
          'radial-gradient(ellipse 52% 52% at ' + x2 + '% ' + y2 + '%, rgba(45,107,255,0.14) 0%, transparent 60%)';

        requestAnimationFrame(tickGradient);
      }

      tickGradient();
    }
  } catch (e) { console.warn('[looped] hero gradient error:', e); }

  // ── 3. INTERACTIVE DM DEMO ──────────────────────────────────────────────────
  try {
    var DEMO_REPLIES = [
      'Hey! Thanks for reaching out. Quick one first, what is your main goal right now?',
      'Got it. I help coaches in exactly that position book 3 to 5 calls a week on autopilot. Want me to send you the details?',
    ];

    var dmMessages  = document.getElementById('dm-messages');
    var dmInput     = document.getElementById('dm-input');
    var dmSendBtn   = document.getElementById('dm-send-btn');
    var dmInputRow  = document.getElementById('dm-input-row');
    var dmTryAgain  = document.getElementById('dm-try-again');
    var dmTryBtn    = document.getElementById('dm-try-again-btn');
    var dmBooked    = document.getElementById('dm-booked');

    if (dmMessages && dmInput && dmSendBtn && dmBooked) {
      var dmExchange = 0;

      function dmScrollBottom() { dmMessages.scrollTop = dmMessages.scrollHeight; }

      function dmAddBubble(text, cls) {
        var div = document.createElement('div');
        div.className = 'dm-bubble ' + cls;
        div.textContent = text;
        dmMessages.insertBefore(div, dmBooked);
        dmScrollBottom();
      }

      function dmSetEnabled(on) {
        dmInput.disabled  = !on;
        dmSendBtn.disabled = !on;
      }

      function dmSend() {
        var text = dmInput.value.trim();
        if (!text || dmExchange >= DEMO_REPLIES.length) return;
        var idx = dmExchange++;
        dmAddBubble(text, 'outgoing');
        dmInput.value = '';
        dmSetEnabled(false);

        var typingDiv = document.createElement('div');
        typingDiv.className = 'dm-typing';
        typingDiv.innerHTML = '<div class="dm-dot"></div><div class="dm-dot"></div><div class="dm-dot"></div>';
        typingDiv.style.display = 'flex';
        dmMessages.insertBefore(typingDiv, dmBooked);
        dmScrollBottom();

        setTimeout(function () {
          typingDiv.remove();
          dmAddBubble(DEMO_REPLIES[idx], 'incoming');
          if (dmExchange >= DEMO_REPLIES.length) {
            setTimeout(function () {
              dmBooked.style.opacity = '1';
              dmScrollBottom();
              if (dmInputRow)  dmInputRow.style.display  = 'none';
              if (dmTryAgain)  dmTryAgain.style.display  = 'block';
            }, 500);
          } else {
            dmSetEnabled(true);
            dmInput.focus();
          }
        }, 1400);
      }

      function dmReset() {
        dmExchange = 0;
        Array.from(dmMessages.children).forEach(function (el) {
          if (el !== dmBooked) el.remove();
        });
        dmBooked.style.opacity = '0';
        if (dmInputRow) dmInputRow.style.display  = 'flex';
        if (dmTryAgain) dmTryAgain.style.display  = 'none';
        dmInput.value = '';
        dmSetEnabled(true);
        dmInput.focus();
      }

      dmSendBtn.addEventListener('click', dmSend);
      dmInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') dmSend(); });
      if (dmTryBtn) dmTryBtn.addEventListener('click', dmReset);
    }
  } catch (e) { console.warn('[looped] dm demo error:', e); }

  // ── 4. STAT COUNTERS ────────────────────────────────────────────────────────
  // STAT_CONFIG: target = final value, suffix appended, comma: true → 12,000 format
  var STAT_CONFIG = [
    { id: 'stat-dms',      target: 12000, suffix: '+', comma: true  },
    { id: 'stat-response', target: 47,    suffix: 's', comma: false },
    { id: 'stat-calls',    target: 820,   suffix: '+', comma: false },
  ];

  try {
    var statsSection = document.getElementById('statsSection');
    console.log('[looped] statsSection found:', !!statsSection);

    if (statsSection && typeof IntersectionObserver !== 'undefined') {
      function statFmt(n, comma) { return comma ? n.toLocaleString('en-GB') : String(n); }

      function animateCounter(el, target, suffix, comma) {
        console.log('[looped] animateCounter start:', el.id, '->', target);
        var duration = 1700, startTime = null;
        function step(ts) {
          if (!startTime) startTime = ts;
          var progress = Math.min((ts - startTime) / duration, 1);
          var eased    = 1 - Math.pow(1 - progress, 3);
          el.textContent = statFmt(Math.round(eased * target), comma) + suffix;
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }

      var statsObs = new IntersectionObserver(function (entries) {
        console.log('[looped] statsObs fired, isIntersecting:', entries[0].isIntersecting);
        if (!entries[0].isIntersecting) return;
        statsObs.disconnect();
        STAT_CONFIG.forEach(function (cfg) {
          var el = document.getElementById(cfg.id);
          if (el) animateCounter(el, cfg.target, cfg.suffix, cfg.comma);
          else console.warn('[looped] stat el not found:', cfg.id);
        });
      }, { threshold: 0.15 });

      statsObs.observe(statsSection);
      console.log('[looped] statsObs observing #statsSection');
    } else if (!statsSection) {
      console.warn('[looped] #statsSection not found in DOM');
    }
  } catch (e) { console.warn('[looped] stats error:', e); }

  // ── 5. SCROLL REVEAL ────────────────────────────────────────────────────────
  try {
    var revealEls = document.querySelectorAll('.reveal');
    console.log('[looped] .reveal elements found:', revealEls.length);

    if (typeof IntersectionObserver === 'undefined') {
      revealEls.forEach(function (el) { el.classList.add('revealed'); });
    } else {
      var revealObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el    = entry.target;
          var delay = parseInt(el.dataset.delay || '0', 10);
          console.log('[looped] reveal firing:', el.className, 'delay:', delay);
          setTimeout(function () { el.classList.add('revealed'); }, delay);
          revealObs.unobserve(el);
        });
      }, { threshold: 0.08 });

      revealEls.forEach(function (el) { revealObs.observe(el); });
    }
  } catch (e) { console.warn('[looped] reveal error:', e); }

})();
</script>

<!-- ═══════════════════════════════════════════════════════════════════
     CHECKOUT SCRIPT — DO NOT MODIFY (handles Stripe redirect)
     ═══════════════════════════════════════════════════════════════════ -->
<script>
  async function startTrial(e) {
    if (e && e.preventDefault) e.preventDefault();

    const btn = document.getElementById('startBtn');
    const errEl = document.getElementById('errMsg');
    if (errEl) errEl.style.display = 'none';
    if (btn) { btn.textContent = 'Redirecting to checkout\u2026'; btn.classList.add('loading'); }

    try {
      // Server creates the Stripe session and returns { url } as JSON.
      // We then navigate directly — fetch() must not follow the Stripe URL
      // itself because cross-origin fetch to stripe.com is blocked by CORS.
      const res = await fetch('/api/trial/checkout/${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }

      if (!data.url) {
        throw new Error('No checkout URL returned. Please try again.');
      }

      window.location.href = data.url;
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
