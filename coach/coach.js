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

// ✅ Set-password form handler (set-password.html has #setPasswordForm)
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("setPasswordForm");
  if (!form) return;

  const token = new URLSearchParams(window.location.search).get("token") || "";
  const errEl = document.getElementById("setPasswordError");
  const okEl = document.getElementById("setPasswordOk");
  const btn = document.getElementById("setPasswordBtn");

  function showErr(msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = "block"; }
    if (okEl) okEl.style.display = "none";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errEl) errEl.style.display = "none";
    if (okEl) okEl.style.display = "none";

    const password = document.getElementById("newPassword")?.value || "";
    const confirm = document.getElementById("confirmPassword")?.value || "";

    if (!token) { showErr("Invalid or missing setup token. Please use the link from your payment confirmation."); return; }
    if (password.length < 8) { showErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { showErr("Passwords do not match."); return; }

    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/coach/api/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showErr(j?.error || "Failed to set password. Please try again."); return; }
      window.location.href = "/coach/login.html?password_set=1";
    } catch {
      showErr("Network error. Please check your connection and try again.");
    } finally {
      if (btn) btn.disabled = false;
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

  const errEl = qs("#instagramConnectError");

  btn.addEventListener("click", async () => {
    if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
    try {
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
      const msg = String(e.message || e);
      if (errEl) { errEl.textContent = msg; errEl.style.display = "block"; }
      else { setErr(msg); }
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
const storyReplyAutoDmEnabledEl = qs("#story_reply_auto_dm_enabled");
const storyReplyAutoDmTextEl = qs("#story_reply_auto_dm_text");
const commentReplyAutoDmEnabledEl = qs("#comment_reply_auto_dm_enabled");
const commentReplyAutoDmTextEl = qs("#comment_reply_auto_dm_text");
const keywordAutoDmEnabledEl = qs("#keyword_auto_dm_enabled");
const keywordTriggerTextEl = qs("#keyword_trigger_text");
const keywordAutoDmTextEl = qs("#keyword_auto_dm_text");

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
if (story_reply_auto_dm_enabled && !story_reply_auto_dm_text) {
  setErr("Add the story reply outbound message or turn Story reply auto-DM off.");
  return;
}

if (comment_reply_auto_dm_enabled && !comment_reply_auto_dm_text) {
  setErr("Add the comment reply outbound message or turn Comment reply auto-DM off.");
  return;
}

if (keyword_auto_dm_enabled && !keyword_trigger_text) {
  setErr("Add the trigger phrase or turn Keyword auto-DM off.");
  return;
}

if (keyword_auto_dm_enabled && !keyword_auto_dm_text) {
  setErr("Add the keyword outbound message or turn Keyword auto-DM off.");
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
const story_reply_auto_dm_enabled =
  storyReplyAutoDmEnabledEl
    ? String(storyReplyAutoDmEnabledEl.value || "false") === "true"
    : false;

const story_reply_auto_dm_text =
  storyReplyAutoDmTextEl
    ? String(storyReplyAutoDmTextEl.value || "").trim()
    : "";

const comment_reply_auto_dm_enabled =
  commentReplyAutoDmEnabledEl
    ? String(commentReplyAutoDmEnabledEl.value || "false") === "true"
    : false;

const comment_reply_auto_dm_text =
  commentReplyAutoDmTextEl
    ? String(commentReplyAutoDmTextEl.value || "").trim()
    : "";

const keyword_auto_dm_enabled =
  keywordAutoDmEnabledEl
    ? String(keywordAutoDmEnabledEl.value || "false") === "true"
    : false;

const keyword_trigger_text =
  keywordTriggerTextEl
    ? String(keywordTriggerTextEl.value || "").trim()
    : "";

const keyword_auto_dm_text =
  keywordAutoDmTextEl
    ? String(keywordAutoDmTextEl.value || "").trim()
    : "";

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
        await loadManualTakeovers(); // reload leads to reflect bulk override change
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

// ---- All leads (replaces manual takeovers) ----

let allLeads = [];

const STAGE_LABELS = {
  new: "New",
  engaged: "Engaged",
  high_intent: "High intent",
  booking_pushed: "Link sent",
  booked: "Booked",
  lost: "Lost",
};

function leadDisplayName(lead) {
  if (lead.ig_name) return lead.ig_name;
  if (lead.email) return lead.email;
  const psid = String(lead.ig_psid || "");
  return psid ? `···${psid.slice(-6)}` : "Unknown";
}

function leadLastActivity(lead) {
  const dates = [lead.last_inbound_at, lead.last_outbound_at].filter(Boolean);
  if (!dates.length) return null;
  return dates.sort().pop();
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtTime(iso).split(",")[0];
}

function renderLeadRow(lead) {
  const name = leadDisplayName(lead);
  const subParts = [];
  if (lead.email) subParts.push(lead.email);
  if (lead.phone) subParts.push(lead.phone);
  if (!subParts.length) subParts.push(`id ···${String(lead.ig_psid || "").slice(-6)}`);
  const subLine = subParts.join(" · ");
  const stage = lead.stage || "new";
  const stageLabel = STAGE_LABELS[stage] || stage;
  const lastMsg = fmtRelative(leadLastActivity(lead));
  const botOn = !lead.manual_override;
  const toggleId = `toggle_${lead.id}`;

  return `<div class="leadRow" data-id="${lead.id}" data-paused="${lead.manual_override ? "1" : "0"}">
    <div class="leadIdent">
      <div class="leadName">${escHtml(name)}</div>
      <div class="leadSub">${escHtml(subLine)} · ${lastMsg}</div>
    </div>
    <span class="badge stageBadge stage-${escHtml(stage)}">${escHtml(stageLabel)}</span>
    <div class="leadToggleWrap">
      <span class="leadToggleLabel">${botOn ? "On" : "Off"}</span>
      <label class="leadToggle" title="${botOn ? "Bot active — click to pause" : "Bot paused — click to resume"}">
        <input type="checkbox" class="leadBotToggle" data-id="${lead.id}" ${botOn ? "checked" : ""}>
        <span class="leadToggleSlider"></span>
      </label>
    </div>
  </div>`;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyLeadsFilters() {
  const searchVal = (qs("#leadsSearch")?.value || "").toLowerCase().trim();
  const filterVal = qs("#leadsFilter")?.value || "all";

  let filtered = allLeads;

  if (filterVal === "active") {
    filtered = filtered.filter((l) => !l.manual_override);
  } else if (filterVal === "paused") {
    filtered = filtered.filter((l) => !!l.manual_override);
  }

  if (searchVal) {
    filtered = filtered.filter((l) => {
      const name = String(l.ig_name || "").toLowerCase();
      const email = String(l.email || "").toLowerCase();
      const psid = String(l.ig_psid || "").toLowerCase();
      const phone = String(l.phone || "").toLowerCase();
      return name.includes(searchVal) || email.includes(searchVal) || psid.includes(searchVal) || phone.includes(searchVal);
    });
  }

  return filtered;
}

function renderLeadsList() {
  const list = qs("#takeoverList");
  const countEl = qs("#leadsCount");
  if (!list) return;

  const filtered = applyLeadsFilters();

  if (countEl) {
    countEl.textContent = `${filtered.length} of ${allLeads.length} lead${allLeads.length !== 1 ? "s" : ""}`;
  }

  if (!filtered.length) {
    list.innerHTML = allLeads.length
      ? `<div class="takeoverMeta">No leads match your search or filter.</div>`
      : `<div class="takeoverMeta">No leads yet. When someone messages your Instagram, they appear here.</div>`;
    return;
  }

  list.innerHTML = filtered.map(renderLeadRow).join("");
  wireLeadToggles();
}

async function loadManualTakeovers() {
  const list = qs("#takeoverList");
  if (!list) return;

  list.innerHTML = `<div class="takeoverMeta">Loading…</div>`;

  try {
    const data = await apiFetch(`${API}/leads`, { method: "GET" });
    allLeads = Array.isArray(data?.leads) ? data.leads : [];
    renderLeadsList();
    wireLeadsSearchAndFilter();
  } catch (e) {
    list.innerHTML = `<div class="takeoverMeta">Failed to load leads.</div>`;
    throw e;
  }
}

function wireLeadsSearchAndFilter() {
  const searchEl = qs("#leadsSearch");
  const filterEl = qs("#leadsFilter");

  if (searchEl && !searchEl.__wired) {
    searchEl.__wired = true;
    // update placeholder to reflect ig_name usage
    if (searchEl.placeholder && searchEl.placeholder.includes("email")) {
      searchEl.placeholder = "Search by name, email or ID…";
    }
    searchEl.addEventListener("input", () => renderLeadsList());
  }

  if (filterEl && !filterEl.__wired) {
    filterEl.__wired = true;
    filterEl.addEventListener("change", () => renderLeadsList());
  }
}

function wireLeadToggles() {
  document.querySelectorAll(".leadBotToggle").forEach((input) => {
    if (input.__wired) return;
    input.__wired = true;

    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-id");
      const botOn = input.checked;

      input.disabled = true;

      try {
        await apiFetch(`${API}/leads/${id}/manual-override`, {
          method: "POST",
          body: JSON.stringify({
            enabled: !botOn,
            reason: botOn ? "Resumed by coach" : "Paused by coach",
          }),
        });

        // Update local data so re-renders stay consistent
        const lead = allLeads.find((l) => l.id === id);
        if (lead) lead.manual_override = !botOn;

        renderLeadsList();
      } catch (e) {
        // Revert toggle on error
        input.checked = !botOn;
        input.disabled = false;
        setErr(String(e.message || e));
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

// Keep alias so broadcast reload can call it too
const loadLeads = loadManualTakeovers;

// ---- Feature 3: Broadcast ----
let broadcastLeads = [];

async function loadBroadcastLeads() {
  const stageFilter = qs("#broadcastStageFilter");
  const stage = stageFilter ? stageFilter.value : "all";
  const listEl = qs("#broadcastLeadList");
  const rowsEl = qs("#broadcastLeadRows");
  const countEl = qs("#broadcastLeadCount");

  try {
    const data = await apiFetch(`${API}/broadcast/leads?stage=${encodeURIComponent(stage)}`, { method: "GET" });
    broadcastLeads = data?.leads || [];
    if (listEl) listEl.style.display = "block";
    if (countEl) countEl.textContent = `${broadcastLeads.length} lead${broadcastLeads.length !== 1 ? "s" : ""} found`;

    if (rowsEl) {
      rowsEl.innerHTML = broadcastLeads.map((l) => {
        const label = l.email ? `${l.email}` : `Lead …${String(l.ig_psid || "").slice(-4)}`;
        return `<label style="display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:#fff; cursor:pointer; font-size:13px;">
          <input type="checkbox" class="broadcastLeadCheck" data-id="${l.id}" style="width:auto; margin:0; padding:0;">
          <span>${label}</span>
          <span class="badge" style="margin-left:auto; font-size:11px;">${l.stage || "new"}</span>
        </label>`;
      }).join("");
    }

    wireBroadcastSelectAll();
  } catch (e) {
    setErr(String(e.message || e));
  }
}

function wireBroadcastSelectAll() {
  const selectAllEl = qs("#broadcastSelectAll");
  if (!selectAllEl || selectAllEl.__wired) return;
  selectAllEl.__wired = true;

  selectAllEl.addEventListener("change", () => {
    document.querySelectorAll(".broadcastLeadCheck").forEach((cb) => {
      cb.checked = selectAllEl.checked;
    });
  });
}

function wireBroadcast() {
  const loadBtn = qs("#loadBroadcastLeadsBtn");
  const sendBtn = qs("#sendBroadcastBtn");
  const statusEl = qs("#broadcastStatus");
  const stageFilter = qs("#broadcastStageFilter");

  if (loadBtn && !loadBtn.__wired) {
    loadBtn.__wired = true;
    loadBtn.addEventListener("click", async () => {
      try {
        clearErr();
        loadBtn.disabled = true;
        loadBtn.textContent = "Loading...";
        await loadBroadcastLeads();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = "Load leads";
      }
    });
  }

  // Auto-reload when stage filter changes (fix: was not reloading before)
  if (stageFilter && !stageFilter.__wired) {
    stageFilter.__wired = true;
    stageFilter.addEventListener("change", async () => {
      const listEl = qs("#broadcastLeadList");
      if (!listEl || listEl.style.display === "none") return; // only reload if already loaded
      await loadBroadcastLeads().catch(() => {});
    });
  }

  if (sendBtn && !sendBtn.__wired) {
    sendBtn.__wired = true;
    sendBtn.addEventListener("click", async () => {
      try {
        clearErr();
        const msgEl = qs("#broadcastMessage");
        const message = msgEl ? String(msgEl.value || "").trim() : "";
        if (!message) {
          setErr("Enter a message to broadcast.");
          return;
        }

        const checkedIds = Array.from(document.querySelectorAll(".broadcastLeadCheck:checked"))
          .map((cb) => cb.getAttribute("data-id"))
          .filter(Boolean);

        if (checkedIds.length === 0) {
          setErr("Select at least one lead.");
          return;
        }

        sendBtn.disabled = true;
        sendBtn.textContent = "Sending...";
        if (statusEl) statusEl.textContent = "";

        const result = await apiFetch(`${API}/broadcast`, {
          method: "POST",
          body: JSON.stringify({ message, lead_ids: checkedIds }),
        });

        if (statusEl) {
          statusEl.textContent = `Queued ${result.queued} message${result.queued !== 1 ? "s" : ""}. ${result.remaining} broadcast slots remaining this hour.`;
        }
        if (msgEl) msgEl.value = "";
        document.querySelectorAll(".broadcastLeadCheck").forEach((cb) => (cb.checked = false));
        const selectAll = qs("#broadcastSelectAll");
        if (selectAll) selectAll.checked = false;

        await loadQueueStatus();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send broadcast";
      }
    });
  }
}

// ---- Feature 4: Queue Status ----
async function loadQueueStatus() {
  const listEl = qs("#queueStatusList");
  const loadingEl = qs("#queueStatusLoading");
  if (!listEl) return;

  try {
    const data = await apiFetch(`${API}/queue-status`, { method: "GET" });
    const c = data?.last_24h || {};
    const broadcastRemaining = data?.broadcast_remaining_this_hour ?? 50;

    const rows = [
      { label: "Pending", value: c.pending ?? 0, cls: c.pending > 0 ? "warn" : "" },
      { label: "Sent (last 24h)", value: c.sent ?? 0, cls: c.sent > 0 ? "connected" : "" },
      { label: "Failed (last 24h)", value: c.failed ?? 0, cls: c.failed > 0 ? "warn" : "" },
      { label: "Broadcast slots left this hour", value: broadcastRemaining, cls: "" },
    ];

    listEl.innerHTML = rows.map((r) => `
      <div class="takeoverRow" style="padding:10px 14px;">
        <div class="takeoverLeft">
          <div class="takeoverMeta">${r.label}</div>
        </div>
        <div class="takeoverRight">
          <span class="badge${r.cls ? " " + r.cls : ""}">${r.value}</span>
        </div>
      </div>
    `).join("");

    if (loadingEl) loadingEl.style.display = "none";
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="takeoverMeta">Could not load queue status</div>`;
  }
}

function wireQueueRefreshButton() {
  const btn = qs("#refreshQueueBtn");
  if (!btn || btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", async () => {
    try {
      clearErr();
      await loadQueueStatus();
    } catch (e) {
      setErr(String(e.message || e));
    }
  });
}

  async function loadDashboard() {
    if (!getToken()) {
      window.location.href = "/coach/login.html";
      return;
    }

    wireTopbarButtons();
    wireInstagramConnectButton();
    wireGlobalPauseButton();
    wireManualTakeoversRefreshButton();
    wireBroadcast();
    wireQueueRefreshButton();

    await Promise.allSettled([
      loadInstagramConnectionStatus(),
      loadGlobalPauseStatus(),
      loadManualTakeovers(),
      loadQueueStatus(),
    ]);
  }


  wireTopbarButtons();
  loadDashboard();
})();
