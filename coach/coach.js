// coach/coach.js

// ✅ Login form handler (login.html has #loginForm)
// If a form exists, we rely on submit only (prevents double-login requests).
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  if (!form) return;
  if (form.__wired) return;
  form.__wired = true;

  const notice = document.getElementById("notice");
  const params = new URLSearchParams(window.location.search);

  if (notice) {
    if (params.get("paid") === "1") {
      notice.className = "notice ok";
      notice.textContent =
        "Payment received. Your account may need a password setup first. If you haven’t set one yet, use the “Set password” button below.";
    } else if (params.get("password_set") === "1") {
      notice.className = "notice ok";
      notice.textContent =
        "Password set successfully. You can now log in.";
    } else if (params.get("cancelled") === "1") {
      notice.className = "notice warn";
      notice.textContent =
        "Payment was cancelled. Complete payment first to access the dashboard.";
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const err = document.getElementById("error");

    if (err) err.style.display = "none";

    try {
      const r = await fetch("/coach/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        if (err) {
          if (j?.error === "subscription_inactive") {
            err.textContent =
              j?.message ||
              "Subscription inactive. Complete payment before logging in.";
          } else {
            err.textContent = j.error || "Login failed";
          }
          err.style.display = "block";
        }
        return;
      }

localStorage.setItem("coach_token", j.token);
      window.location.href = "/coach/dashboard.html";
    } catch (e) {
      if (err) {
        err.textContent = "Network error";
        err.style.display = "block";
      }
    }
  });
});

(function () {
  const API = "/coach/api";
  const TOKEN_KEY = "coach_token";

  const qs = (sel) => document.querySelector(sel);
  const show = (el) => (el.style.display = "block");
  const hide = (el) => (el.style.display = "none");

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(t) {
    localStorage.setItem(TOKEN_KEY, t);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function setErr(msg) {
    const err = qs("#err");
    const ok = qs("#ok");
    if (ok) hide(ok);
    if (!err) return;
    err.textContent = msg;
    show(err);
  }

  function clearErr() {
    const err = qs("#err");
    if (!err) return;
    err.textContent = "";
    hide(err);
  }
  function isValidUrl(str) {
    if (!str) return true;
    try {
      const u = new URL(str);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function isValidIgHandle(str) {
    if (!str) return true;
    const s = String(str).trim();
    const h = s.startsWith("@") ? s.slice(1) : s;
    return /^[a-zA-Z0-9._]{1,30}$/.test(h);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }
function getTimeUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);

  const diffMs = tomorrow.getTime() - now.getTime();
  const totalMinutes = Math.max(0, Math.floor(diffMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}
function parseExampleMessages(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: true, value: "" };

  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cleaned = [];

  for (const block of blocks) {
    const match = block.match(/user:\s*([\s\S]*?)\nassistant:\s*([\s\S]*)/i);

    if (!match) {
      return {
        ok: false,
        error:
          "Example messages format is invalid.\n\nUse:\nuser: ...\nassistant: ...",
      };
    }

    const user = String(match[1] || "").trim();
    const assistant = String(match[2] || "").trim();

    if (!user || !assistant) {
      return {
        ok: false,
        error: "Each example must include both a user line and an assistant line.",
      };
    }

    cleaned.push(`user: ${user}\nassistant: ${assistant}`);
  }

  return {
    ok: true,
    value: cleaned.join("\n\n"),
  };
}
function getDefaultExampleMessages() {
  return `user: how much is it?
assistant: it’s £200 setup and £90 a month after that

user: what do you actually help with?
assistant: i help people get a proper result with structure, support and a plan that actually fits them

user: i’m not sure if it’s for me
assistant: what’s making you unsure?

user: how does it work?
assistant: you book in, we go through where you’re at, then we get everything set up properly from there

user: i’ll think about it
assistant: fair - what do you need to see before you can decide properly?`;
}
function buildStructuredCoachContext({
  offer_what = "",
  offer_features = "",
  offer_audience = "",
  offer_process = "",
  main_result = "",
  best_fit_leads = "",
  not_a_fit = "",
  common_objections = "",
  closing_triggers = "",
  urgency_reason = "",
  trust_builders = "",
  faq = "",
}) {
  const sections = [];

  if (offer_what) sections.push(`What you do:\n${offer_what}`);
  if (offer_features) sections.push(`What they get:\n${offer_features}`);
  if (offer_audience) sections.push(`Who it's for:\n${offer_audience}`);
  if (offer_process) sections.push(`How it works:\n${offer_process}`);
  if (main_result) sections.push(`Main result:\n${main_result}`);
  if (best_fit_leads) sections.push(`Best fit leads:\n${best_fit_leads}`);
  if (not_a_fit) sections.push(`Not a fit:\n${not_a_fit}`);
  if (common_objections) sections.push(`Common objections:\n${common_objections}`);
  if (closing_triggers) sections.push(`Closing triggers:\n${closing_triggers}`);
  if (urgency_reason) sections.push(`Urgency / why now:\n${urgency_reason}`);
  if (trust_builders) sections.push(`Trust builders:\n${trust_builders}`);
  if (faq) sections.push(`FAQ:\n${faq}`);

  return sections.join("\n\n");
}
  async function apiFetch(path, opts = {}) {
    const token = getToken();

    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {}
    );

    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, Object.assign({}, opts, { headers }));

    const text = await res.text();

    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg =
        json?.error ||
        json?.message ||
        json?.raw ||
        `Request failed (${res.status})`;

      const err = new Error(msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }

    return json;
  }

  function wireTopbarButtons() {
    const refreshBtn = qs("#refreshBtn");
    const logoutBtn = qs("#logoutBtn");

    if (logoutBtn && !logoutBtn.__wired) {
      logoutBtn.__wired = true;
      logoutBtn.addEventListener("click", () => {
        clearToken();
        window.location.href = "/coach/login.html";
      });
    }

    if (refreshBtn && !refreshBtn.__wired) {
      refreshBtn.__wired = true;
      refreshBtn.addEventListener("click", async () => {
        try {
          clearErr();
          await loadDashboard();
        } catch (e) {
          setErr(String(e.message || e));
        }
      });
    }
  }
async function loadInstagramConnectionStatus() {
  const badgeEl = qs("#instagramConnectionBadge");
  const metaEl = qs("#instagramConnectionMeta");
  const btn = qs("#connectInstagramBtn");

  if (!badgeEl || !metaEl || !btn) return;

  try {
    const data = await apiFetch(`${API}/instagram/status`, {
      method: "GET",
    });

    if (data?.connected) {
badgeEl.className = "badge connected";
      badgeEl.textContent = "Connected";

      metaEl.textContent = data.username
        ? `Connected as @${data.username}`
        : "Instagram connected";

      btn.textContent = "Reconnect Instagram";
      btn.disabled = false;
      btn.style.opacity = "1";
    } else {
      badgeEl.className = "badge warn";
      badgeEl.textContent = "Not connected";

      metaEl.textContent = "No Instagram account connected yet.";

      btn.textContent = "Connect Instagram";
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  } catch (e) {
    badgeEl.className = "badge warn";
    badgeEl.textContent = "Error";

    metaEl.textContent = "Failed to load Instagram status.";

    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

function wireInstagramConnectButton() {
  const btn = qs("#connectInstagramBtn");
  if (!btn || btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", async () => {
    try {
      clearErr();

      btn.disabled = true;
      btn.style.opacity = "0.75";
      btn.textContent = "Opening Instagram…";

      const data = await apiFetch(`${API}/instagram/connect-url`, {
        method: "GET",
      });

      if (!data?.url) {
        throw new Error("Missing Instagram connect URL");
      }

      window.location.href = data.url;
    } catch (e) {
      setErr(String(e.message || e));
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.textContent = "Connect Instagram";
    }
  });
}
function wireGeneratePromptButton() {
const btn = qs("#generatePromptBtn");
const igEl = qs("#instagram_handle");
const nicheEl = qs("#niche");
const promptEl = qs("#system_prompt");
const exampleEl = qs("#example_messages");
const promptStatusEl = qs("#promptStatus");
const offerWhatEl = qs("#offer_what");
const offerFeaturesEl = qs("#offer_features");
const offerAudienceEl = qs("#offer_audience");
const offerProcessEl = qs("#offer_process");
const mainResultEl = qs("#main_result");
const bestFitLeadsEl = qs("#best_fit_leads");
const notAFitEl = qs("#not_a_fit");
const commonObjectionsEl = qs("#common_objections");
const closingTriggersEl = qs("#closing_triggers");
const urgencyReasonEl = qs("#urgency_reason");
const trustBuildersEl = qs("#trust_builders");
const faqEl = qs("#faq");
const offerPriceEl = qs("#offer_price");

  if (!btn || btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", async () => {
    try {
      clearErr();

      if (promptStatusEl) {
        promptStatusEl.textContent = "";
      }

const instagram_handle = igEl ? String(igEl.value || "").trim() : "";

if (!instagram_handle) {
  setErr("Enter your Instagram handle first.");
  return;
}

if (!isValidIgHandle(instagram_handle)) {
  setErr("Instagram handle format is invalid.");
  return;
}
const offer_what = offerWhatEl ? String(offerWhatEl.value || "").trim() : "";
const offer_features = offerFeaturesEl ? String(offerFeaturesEl.value || "").trim() : "";
const offer_audience = offerAudienceEl ? String(offerAudienceEl.value || "").trim() : "";
const offer_process = offerProcessEl ? String(offerProcessEl.value || "").trim() : "";
const main_result = mainResultEl ? String(mainResultEl.value || "").trim() : "";
const best_fit_leads = bestFitLeadsEl ? String(bestFitLeadsEl.value || "").trim() : "";
const not_a_fit = notAFitEl ? String(notAFitEl.value || "").trim() : "";
const common_objections = commonObjectionsEl ? String(commonObjectionsEl.value || "").trim() : "";
const closing_triggers = closingTriggersEl ? String(closingTriggersEl.value || "").trim() : "";
const urgency_reason = urgencyReasonEl ? String(urgencyReasonEl.value || "").trim() : "";
const trust_builders = trustBuildersEl ? String(trustBuildersEl.value || "").trim() : "";
const faq = faqEl ? String(faqEl.value || "").trim() : "";
const offer_price = offerPriceEl ? String(offerPriceEl.value || "").trim() : "";
const example_messages = exampleEl ? String(exampleEl.value || "").trim() : "";
const niche = nicheEl ? String(nicheEl.value || "generic").trim() : "generic";

      btn.disabled = true;
      btn.style.opacity = "0.75";
      btn.textContent = "Generating...";

      if (promptStatusEl) {
        promptStatusEl.textContent =
          "Generating coach voice from your settings...";
      }
const offer_description = buildStructuredCoachContext({
  offer_what,
  offer_features,
  offer_audience,
  offer_process,
  main_result,
  best_fit_leads,
  not_a_fit,
  common_objections,
  closing_triggers,
  urgency_reason,
  trust_builders,
  faq,
});

const data = await apiFetch(`${API}/generate-prompt`, {
  method: "POST",
body: JSON.stringify({
  instagram_handle,
  niche,
  example_messages,
  offer_description,
  offer_price,
  what_you_do: offer_what,
  what_they_get: offer_features,
  who_its_for: offer_audience,
  how_it_works: offer_process,
  main_result,
  best_fit_leads,
  not_a_fit,
  common_objections,
  closing_triggers,
  urgency_reason,
  trust_builders,
  faq,
}),
});

      if (promptEl && data?.system_prompt) {
        promptEl.value = data.system_prompt;
      }

      if (promptStatusEl) {
        const tone = data?.tone || "direct";
        const style = data?.style || "short, punchy";
        const vocabulary = data?.vocabulary || "casual";
        const remaining = Number(data?.remaining ?? 0);

        promptStatusEl.textContent =
          `Updated. Tone: ${tone}. Style: ${style}. Vocabulary: ${vocabulary}. ${remaining} left today.`;
      }

      await loadPromptUsageStatus();
    } catch (e) {
      setErr(String(e.message || e));

      if (promptStatusEl) {
        if (String(e.message || "").includes("daily_limit_reached")) {
          promptStatusEl.textContent = "Daily prompt limit reached.";
        } else {
          promptStatusEl.textContent = "Failed to generate prompt.";
        }
      }

      await loadPromptUsageStatus();
} finally {
  btn.disabled = false;
  btn.style.opacity = "1";
  await loadPromptUsageStatus();
}
  });
}
async function loadPromptUsageStatus() {
const el = qs("#promptLimitStatus");
  if (!el) return;

  try {
    const data = await apiFetch(`${API}/prompt-usage`, {
      method: "GET",
    });

    const remaining = Number(data?.remaining ?? 0);
    const max = Number(data?.max ?? 10);
    const used = Number(data?.used ?? 0);
const btn = qs("#generatePromptBtn");

if (btn) {
  if (remaining <= 0) {
    btn.disabled = true;
    btn.classList.add("disabled");
    btn.textContent = "Limit reached";
  } else {
    btn.disabled = false;
    btn.classList.remove("disabled");
    btn.textContent = "Generate Prompt";
  }
}
const resetTime = getTimeUntilTomorrow();

el.textContent =
  remaining > 0
    ? `${remaining} / ${max} prompt generations left today (resets in ${resetTime})`
    : `Limit reached — resets in ${resetTime}`;
    el.style.color = remaining <= 2 ? "#b54708" : "var(--muted)";
 } catch (e) {
    el.textContent = "Could not load prompt usage";
    el.style.color = "#c0262d";
  }
}

async function loadGlobalPauseStatus() {
  const badge = qs("#globalPauseBadge");
  const meta = qs("#globalPauseMeta");
  const input = qs("#globalPauseReason");
  const btn = qs("#toggleGlobalPauseBtn");

  if (!badge || !meta || !btn) return;

  const data = await apiFetch(`${API}/bot-paused`, { method: "GET" });
  const status = data?.status || {};
  const paused = !!status.bot_paused;

badge.className = paused ? "badge globalPaused" : "badge connected";
  badge.textContent = paused ? "Bot paused" : "Bot running";

  meta.textContent = status.bot_paused_at
    ? `Updated ${fmtTime(status.bot_paused_at)}`
    : "—";

  if (input) input.value = status.bot_paused_reason || "";

  btn.textContent = paused
    ? "Resume bot globally"
    : "Pause bot globally";
}

function wireGlobalPauseButton() {
  const btn = qs("#toggleGlobalPauseBtn");
  const input = qs("#globalPauseReason");
  const refreshBtn = qs("#refreshGlobalPauseBtn");

  if (btn && !btn.__wired) {
    btn.__wired = true;

    btn.addEventListener("click", async () => {
      try {
        clearErr();

        const paused =
          (qs("#globalPauseBadge")?.textContent || "")
            .toLowerCase()
            .includes("paused");

        btn.disabled = true;
        btn.style.opacity = "0.75";

        await apiFetch(`${API}/bot-paused`, {
          method: "POST",
          body: JSON.stringify({
            enabled: !paused,
            reason: input ? String(input.value || "").trim() : "",
          }),
        });

        await loadGlobalPauseStatus();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
      }
    });
  }

  if (refreshBtn && !refreshBtn.__wired) {
    refreshBtn.__wired = true;

    refreshBtn.addEventListener("click", async () => {
      try {
        clearErr();
        await loadGlobalPauseStatus();
      } catch (e) {
        setErr(String(e.message || e));
      }
    });
  }
}

async function loadManualTakeovers() {
  const list = qs("#takeoverList");
  if (!list) return;

  list.innerHTML = `<div class="takeoverMeta">Loading...</div>`;

  const data = await apiFetch(`${API}/leads`, { method: "GET" });
  const leads = Array.isArray(data?.leads) ? data.leads : [];

  const overridden = leads.filter((l) => !!l.manual_override);

  if (!overridden.length) {
    list.innerHTML = `<div class="takeoverMeta">No manual takeovers right now.</div>`;
    return;
  }

list.innerHTML = overridden
  .map((lead) => {
const name = `Lead ${String(lead.ig_psid || "").slice(-4)}`;

    return `
      <div class="takeoverRow">
        <div class="takeoverLeft">
          <div class="takeoverName">${name}</div>
          <div class="takeoverMeta">
            ${lead.manual_override_reason || "Manual reply detected"}
          </div>
          <div class="takeoverMeta">
            ${fmtTime(lead.manual_override_at)}
          </div>
        </div>

        <div class="takeoverRight">
          <button data-id="${lead.id}" class="btn small resumeTakeoverBtn">
            Resume bot
          </button>
        </div>
      </div>
    `;
  })
  .join("");
  wireResumeTakeoverButtons();
}

function wireResumeTakeoverButtons() {
  document.querySelectorAll(".resumeTakeoverBtn").forEach((btn) => {
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");

      try {
        clearErr();

        btn.disabled = true;
        btn.textContent = "Resuming...";

        await apiFetch(`${API}/leads/${id}/manual-override`, {
          method: "POST",
          body: JSON.stringify({
            enabled: false,
            reason: "Resumed by coach",
          }),
        });

        await loadManualTakeovers();
      } catch (e) {
        setErr(String(e.message || e));
        btn.disabled = false;
        btn.textContent = "Resume";
      }
    });
  });
}

function wireManualTakeoversRefreshButton() {
  const btn = qs("#refreshTakeoversBtn");

  if (!btn || btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", async () => {
    try {
      clearErr();
      await loadManualTakeovers();
    } catch (e) {
      setErr(String(e.message || e));
    }
  });
}
  async function loadDashboard() {
const bookingEl = qs("#booking_url");
const bookingAltEl = qs("#booking_url_alt");
const igEl = qs("#instagram_handle");
const nicheEl = qs("#niche");
const toneEl = qs("#tone");
const styleEl = qs("#style");
const vocabularyEl = qs("#vocabulary");
const promptEl = qs("#system_prompt");
const saveBtn = qs("#saveBtn");
const offerWhatEl = qs("#offer_what");
const offerFeaturesEl = qs("#offer_features");
const offerAudienceEl = qs("#offer_audience");
const offerProcessEl = qs("#offer_process");
const mainResultEl = qs("#main_result");
const bestFitLeadsEl = qs("#best_fit_leads");
const notAFitEl = qs("#not_a_fit");
const commonObjectionsEl = qs("#common_objections");
const closingTriggersEl = qs("#closing_triggers");
const urgencyReasonEl = qs("#urgency_reason");
const trustBuildersEl = qs("#trust_builders");
const faqEl = qs("#faq");
const offerPriceEl = qs("#offer_price");

if (!promptEl && !saveBtn) return;

    if (!getToken()) {
      window.location.href = "/coach/login.html";
      return;
    }
await loadPromptUsageStatus();

    const cfg = await apiFetch(`${API}/config`, { method: "GET" });
    const config = cfg?.config || {};

if (bookingEl) bookingEl.value = config.booking_url || "";
if (bookingAltEl) bookingAltEl.value = config.booking_url_alt || "";
if (igEl) igEl.value = config.instagram_handle || "";
if (nicheEl) nicheEl.value = config.niche || "generic";
if (toneEl) toneEl.value = config.tone || "";
if (styleEl) styleEl.value = config.style || "";
if (vocabularyEl) vocabularyEl.value = config.vocabulary || "";
if (promptEl) promptEl.value = config.system_prompt || "";
const savedOffer = String(config.offer_description || "");

function extractSection(label, nextLabel) {
  const regex = nextLabel
    ? new RegExp(`${label}:\\s*([\\s\\S]*?)\\n\\n${nextLabel}:`, "i")
    : new RegExp(`${label}:\\s*([\\s\\S]*)$`, "i");

  const match = savedOffer.match(regex);
  return match ? String(match[1] || "").trim() : "";
}

function extractSingleSection(label) {
  const regex = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n\\n[A-Z][^\\n]*:|$)`, "i");
  const match = savedOffer.match(regex);
  return match ? String(match[1] || "").trim() : "";
}

if (offerWhatEl) {
  offerWhatEl.value =
    config.what_you_do || extractSection("What you do", "What they get");
}

if (offerFeaturesEl) {
  offerFeaturesEl.value =
    config.what_they_get || extractSection("What they get", "Who it's for");
}

if (offerAudienceEl) {
  offerAudienceEl.value =
    config.who_its_for || extractSection("Who it's for", "How it works");
}

if (offerProcessEl) {
  offerProcessEl.value =
    config.how_it_works || extractSingleSection("How it works");
}
if (mainResultEl) {
  mainResultEl.value = config.main_result || extractSingleSection("Main result");
}

if (bestFitLeadsEl) {
  bestFitLeadsEl.value =
    config.best_fit_leads || extractSingleSection("Best fit leads");
}

if (notAFitEl) {
  notAFitEl.value =
    config.not_a_fit || extractSingleSection("Not a fit");
}

if (commonObjectionsEl) {
  commonObjectionsEl.value =
    config.common_objections || extractSingleSection("Common objections");
}

if (closingTriggersEl) {
  closingTriggersEl.value =
    config.closing_triggers || extractSingleSection("Closing triggers");
}

if (urgencyReasonEl) {
  urgencyReasonEl.value =
    config.urgency_reason || extractSingleSection("Urgency / why now");
}

if (trustBuildersEl) {
  trustBuildersEl.value =
    config.trust_builders || extractSingleSection("Trust builders");
}

if (faqEl) {
  faqEl.value = config.faq || extractSingleSection("FAQ");
}
if (offerPriceEl) offerPriceEl.value = config.offer_price || "";

const exampleEl = qs("#example_messages");
if (exampleEl) {
  exampleEl.value = config.example_messages || getDefaultExampleMessages();
}
wireInstagramConnectButton();
wireGeneratePromptButton();
wireGlobalPauseButton();
wireManualTakeoversRefreshButton();
await Promise.allSettled([
  loadInstagramConnectionStatus(),
  loadPromptUsageStatus(),
  loadGlobalPauseStatus(),
  loadManualTakeovers(),
]);

    if (saveBtn && !saveBtn.__wired) {
      saveBtn.__wired = true;

      saveBtn.addEventListener("click", async () => {
        try {
          clearErr();

const booking_url = bookingEl ? String(bookingEl.value || "").trim() : "";
const booking_url_alt = bookingAltEl
  ? String(bookingAltEl.value || "").trim()
  : "";
const instagram_handle = igEl ? String(igEl.value || "").trim() : "";
const niche = nicheEl ? String(nicheEl.value || "generic").trim() : "generic";
const tone = toneEl ? String(toneEl.value || "").trim() : "";
const style = styleEl ? String(styleEl.value || "").trim() : "";
const vocabulary = vocabularyEl ? String(vocabularyEl.value || "").trim() : "";
const system_prompt = promptEl ? String(promptEl.value || "").trim() : "";
const rawExamples = exampleEl ? String(exampleEl.value || "").trim() : "";
const offer_what = offerWhatEl ? String(offerWhatEl.value || "").trim() : "";
const offer_features = offerFeaturesEl ? String(offerFeaturesEl.value || "").trim() : "";
const offer_audience = offerAudienceEl ? String(offerAudienceEl.value || "").trim() : "";
const offer_process = offerProcessEl ? String(offerProcessEl.value || "").trim() : "";
const main_result = mainResultEl ? String(mainResultEl.value || "").trim() : "";
const best_fit_leads = bestFitLeadsEl ? String(bestFitLeadsEl.value || "").trim() : "";
const not_a_fit = notAFitEl ? String(notAFitEl.value || "").trim() : "";
const common_objections = commonObjectionsEl ? String(commonObjectionsEl.value || "").trim() : "";
const closing_triggers = closingTriggersEl ? String(closingTriggersEl.value || "").trim() : "";
const urgency_reason = urgencyReasonEl ? String(urgencyReasonEl.value || "").trim() : "";
const trust_builders = trustBuildersEl ? String(trustBuildersEl.value || "").trim() : "";
const faq = faqEl ? String(faqEl.value || "").trim() : "";
const offer_price = offerPriceEl ? String(offerPriceEl.value || "").trim() : "";
if (!isValidUrl(booking_url)) {
  setErr("Booking URL must be a valid http or https URL.");
  return;
}

if (!isValidUrl(booking_url_alt)) {
  setErr("Alt Booking URL must be a valid http or https URL.");
  return;
}

if (!isValidIgHandle(instagram_handle)) {
  setErr("Instagram handle format is invalid.");
  return;
}
const offer_description = buildStructuredCoachContext({
  offer_what,
  offer_features,
  offer_audience,
  offer_process,
  main_result,
  best_fit_leads,
  not_a_fit,
  common_objections,
  closing_triggers,
  urgency_reason,
  trust_builders,
  faq,
});

let example_messages = "";

if (!rawExamples.trim()) {
  // ✅ fallback to default examples
  example_messages = getDefaultExampleMessages();
} else {
  const parsedExamples = parseExampleMessages(rawExamples);

  if (!parsedExamples.ok) {
    setErr(parsedExamples.error);
    return;
  }

  example_messages = parsedExamples.value;
}

if (!system_prompt && !offer_description && !example_messages) {
  setErr("Add at least some context — examples, offer details, FAQs, objections, or a prompt.");
  return;
}

          saveBtn.disabled = true;
          saveBtn.style.opacity = "0.75";

const payload = {
  booking_url: booking_url || null,
  booking_url_alt: booking_url_alt || null,
  instagram_handle: instagram_handle || null,
  niche: niche || "generic",
  tone: tone || null,
  style: style || null,
  vocabulary: vocabulary || null,
  system_prompt,
  example_messages,
  offer_description: offer_description || null,
  offer_price: offer_price || null,
  what_you_do: offer_what || null,
  what_they_get: offer_features || null,
  who_its_for: offer_audience || null,
  how_it_works: offer_process || null,
  main_result: main_result || null,
  best_fit_leads: best_fit_leads || null,
  not_a_fit: not_a_fit || null,
  common_objections: common_objections || null,
  closing_triggers: closing_triggers || null,
  urgency_reason: urgency_reason || null,
  trust_builders: trust_builders || null,
  faq: faq || null,
};
          await apiFetch(`${API}/config`, {
            method: "POST",
            body: JSON.stringify(payload),
          });

          window.location.href = "/coach/saved.html";
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          saveBtn.disabled = false;
          saveBtn.style.opacity = "1";
        }
      });
    }
  }

  wireTopbarButtons();
  loadDashboard();
})();
