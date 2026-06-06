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
    if (params.get('paid') === '1') {
      notice.className = 'notice ok';
      notice.textContent =
        `Payment received. Your account may need a password setup first. If you haven\u2019t set one yet, use the \u201cSet password\u201d button below.`;
    } else if (params.get('password_set') === '1') {
      notice.className = 'notice ok';
      notice.textContent =
        'Password set successfully. You can now log in.';
    } else if (params.get('cancelled') === '1') {
      notice.className = 'notice warn';
      notice.textContent =
        'Payment was cancelled. Complete payment first to access the dashboard.';
    }
  }

  const igErr = params.get('instagram_error');
  if (igErr) {
    const igErrEl = document.getElementById('igError');
    if (igErrEl) {
      igErrEl.textContent = decodeURIComponent(igErr);
      igErrEl.style.display = 'block';
    }
    window.history.replaceState({}, '', window.location.pathname);
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
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
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

    const webhookBadge = qs("#asBadgeWebhook");
    if (data?.connected) {
      badgeEl.className = "badge connected";
      badgeEl.textContent = "Connected";

      metaEl.textContent = data.username
        ? `Connected as @${data.username}`
        : "Instagram connected";

      btn.textContent = "Reconnect Instagram";
      btn.disabled = false;
      btn.style.opacity = "1";

      if (webhookBadge) webhookBadge.className = "asBadge asBadge--green";
    } else {
      badgeEl.className = "badge warn";
      badgeEl.textContent = "Not connected";

      metaEl.textContent = "No Instagram account connected yet.";

      btn.textContent = "Connect Instagram";
      btn.disabled = false;
      btn.style.opacity = "1";

      if (webhookBadge) webhookBadge.className = "asBadge asBadge--grey";
    }
  } catch (e) {
    // Real auth failure — clear stale token then send back to login
    if (e?.status === 401) {
      clearToken();
      window.location.href = "/coach/login.html";
      return;
    }
    // Log the real error so it's visible in the browser console
    console.error("[Instagram status] check failed:", e?.status, e?.message, e?.payload);
    // Don't show "Not connected" for API errors — the account may still be connected.
    // Show a neutral state so the user knows something went wrong, not that they're unconnected.
    badgeEl.className = "badge";
    badgeEl.textContent = "Status unavailable";
    metaEl.textContent = `Could not check connection (HTTP ${e?.status || "network error"}). Open browser console for details.`;
    btn.textContent = "Connect Instagram";
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

async function loadCommentActivity() {
  const bodyEl = qs("#commentActivityBody");
  if (!bodyEl) return;

  try {
    const data = await apiFetch(`${API}/comment-activity`, { method: "GET" });
    const rows = data?.rows || [];

    if (!rows.length) {
      bodyEl.innerHTML = `<div class="takeoverMeta" style="margin-top:12px;">No comment activity yet.</div>`;
      return;
    }

    const fmtDate = (iso) => {
      try {
        return new Date(iso).toLocaleString(undefined, {
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
      } catch { return iso; }
    };

    const rowsHtml = rows.map((r) => {
      const keyword  = r.keyword ? `<span class="mono">${r.keyword.replace(/</g, "&lt;")}</span>` : `<span style="color:var(--muted)">-</span>`;
      const username = r.ig_username ? `@${r.ig_username.replace(/</g, "&lt;")}` : `<span style="color:var(--muted)">unknown</span>`;

      return `<tr>
        <td style="white-space:nowrap;">${fmtDate(r.created_at)}</td>
        <td>${username}</td>
        <td>${keyword}</td>
        <td><span class="statusBadge sent">DM Sent</span></td>
      </tr>`;
    }).join("");

    bodyEl.innerHTML = `
      <table class="activityTable">
        <thead>
          <tr>
            <th>Date / Time</th>
            <th>Instagram Username</th>
            <th>Keyword Used</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
  } catch {
    bodyEl.innerHTML = `<div class="takeoverMeta" style="margin-top:12px;">Failed to load activity.</div>`;
  }
}

function wireCommentActivityRefresh() {
  const btn = qs("#refreshCommentActivityBtn");
  if (!btn || btn.__wired) return;
  btn.__wired = true;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await loadCommentActivity();
    btn.disabled = false;
  });
}

async function loadInstagramProfile() {
  const profileCard = qs("#igProfileCard");
  const mediaCard   = qs("#igMediaCard");
  if (!profileCard || !mediaCard) return;

  try {
    const data = await apiFetch(`${API}/instagram/profile`, { method: "GET" });

    if (!data?.connected) {
      profileCard.style.display = "none";
      mediaCard.style.display   = "none";
      return;
    }

    // ── Profile card ──────────────────────────────────────────────────────
    const p = data.profile || {};
    const contentEl = qs("#igProfileContent");
    if (contentEl) {
      const avatarHtml = p.profile_picture_url
        ? `<img class="igAvatar" src="${p.profile_picture_url}" alt="Profile picture"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="igAvatarFallback" style="display:none;">${(p.username || "?")[0].toUpperCase()}</div>`
        : `<div class="igAvatarFallback">${(p.username || "?")[0].toUpperCase()}</div>`;

      const followersHtml = p.followers_count !== null && p.followers_count !== undefined
        ? `<div class="igFollowers"><span class="igFollowersNum">${Number(p.followers_count).toLocaleString()}</span> followers</div>`
        : "";

      const bioHtml = p.biography
        ? `<div class="igProfileBio">${p.biography.replace(/</g, "&lt;")}</div>`
        : "";

      contentEl.innerHTML = `
        ${avatarHtml}
        <div class="igProfileInfo">
          <div class="igProfileName">${(p.name || p.username || "").replace(/</g, "&lt;")}</div>
          <div class="igProfileHandle">@${(p.username || "").replace(/</g, "&lt;")}</div>
          ${bioHtml}
          ${followersHtml}
        </div>`;
    }
    profileCard.style.display = "block";

    // ── Media grid ────────────────────────────────────────────────────────
    const gridEl = qs("#igMediaGrid");
    if (gridEl && Array.isArray(data.media) && data.media.length) {
      gridEl.innerHTML = data.media.map((m) => {
        const imgSrc = m.thumbnail_url || "";
        const href   = m.permalink    || "#";
        return `<div class="igMediaItem">
          <a href="${href}" target="_blank" rel="noopener noreferrer">
            <img src="${imgSrc}" alt="Instagram post" loading="lazy">
          </a>
        </div>`;
      }).join("");
      mediaCard.style.display = "block";
    } else {
      mediaCard.style.display = "none";
    }

  } catch {
    // Non-critical — hide both sections silently on any error
    profileCard.style.display = "none";
    mediaCard.style.display   = "none";
  }
}

function wireInstagramConnectButton() {
  const btn = qs("#connectInstagramBtn");
  if (!btn || btn.__wired) return;
  btn.__wired = true;

  const errEl = qs("#instagramConnectError");

  btn.addEventListener("click", async () => {
    if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
    const originalText = btn.textContent;
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
      btn.textContent = originalText;
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
    : "";

  if (input) input.value = status.bot_paused_reason || "";

  btn.textContent = paused
    ? "Resume all messaging globally"
    : "Pause all messaging globally";
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
  if (lead.ig_name && lead.ig_name !== "Loading...") return lead.ig_name;
  if (lead.email) return lead.email;
  if (lead.ig_name === "Loading...") return "Loading...";
  const psid = String(lead.ig_psid || "");
  return psid ? `···${psid.slice(-6)}` : "Unknown";
}

function isLoadingLead(lead) {
  return lead.ig_name === "Loading...";
}

function leadLastActivity(lead) {
  const dates = [lead.last_inbound_at, lead.last_outbound_at].filter(Boolean);
  if (!dates.length) return null;
  return dates.sort().pop();
}

function fmtRelative(iso) {
  if (!iso) return "no activity";
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
  const isPaused = lead.manual_override === true;
  const botOn = !isPaused;

  const loading = isLoadingLead(lead);
  return `<div class="leadRow${isPaused ? " leadRow--paused" : ""}" data-id="${lead.id}" data-paused="${isPaused ? "1" : "0"}"${loading ? ' data-loading="1"' : ""}>
    <div class="leadIdent">
      <div class="leadName${loading ? " leadName--loading" : ""}">${escHtml(name)}</div>
      <div class="leadSub">${escHtml(subLine)} · ${lastMsg}</div>
      <button class="leadChatBtn" data-id="${lead.id}" data-name="${escHtml(name)}" data-sub="${escHtml(subLine)}">View chat</button>
    </div>
    <span class="badge stageBadge stage-${escHtml(stage)}">${escHtml(stageLabel)}</span>
    ${isPaused ? `<span class="badge leadPausedBadge">Bot paused</span>` : `<span class="badge leadPausedBadge leadPausedBadge--hidden"></span>`}
    <button class="leadResetBtn${botOn ? " leadResetBtn--hidden" : ""}" data-id="${lead.id}" title="Clear the pause and resume the bot for this lead immediately">Reset bot</button>
    <div class="leadToggleWrap">
      <div class="leadToggleRow">
        <span class="leadToggleLabel">${botOn ? "On" : "Off"}</span>
        <label class="leadToggle" title="${botOn ? "Bot active - click to pause" : "Bot paused - click to resume"}">
          <input type="checkbox" class="leadBotToggle" data-id="${lead.id}" ${botOn ? "checked" : ""}>
          <span class="leadToggleSlider"></span>
        </label>
      </div>
      <span class="leadToggleHint">Toggle off to pause all messaging to this lead.</span>
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
  wireInboxButtons();
  startLoadingLeadPollers();
}

// ── Loading... lead poller ────────────────────────────────────────────────────
// For each lead row marked data-loading="1", polls GET /leads/:id every 3s until
// ig_name resolves, then updates the row in-place without a full list re-render.
const _loadingPollers = new Map(); // leadId → intervalId

function startLoadingLeadPollers() {
  const loadingRows = document.querySelectorAll('[data-loading="1"]');
  loadingRows.forEach((row) => {
    const leadId = row.dataset.id;
    if (!leadId || _loadingPollers.has(leadId)) return;

    const intervalId = setInterval(async () => {
      try {
        const data = await apiFetch(`${API}/leads/${leadId}`, { method: "GET" });
        const lead = data?.lead;
        if (!lead) return;

        if (lead.ig_name && lead.ig_name !== "Loading...") {
          // Name resolved — update allLeads cache, re-render the row in-place
          const idx = allLeads.findIndex((l) => l.id === leadId);
          if (idx !== -1) allLeads[idx] = { ...allLeads[idx], ...lead };

          const liveRow = document.querySelector(`[data-id="${leadId}"]`);
          if (liveRow) {
            const newHtml = renderLeadRow(lead);
            liveRow.outerHTML = newHtml;
            // Re-wire the replaced row
            wireLeadToggles();
            wireInboxButtons();
          }

          clearInterval(intervalId);
          _loadingPollers.delete(leadId);
        }
      } catch {}
    }, 3000);

    _loadingPollers.set(leadId, intervalId);
  });
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

  // "Reset bot" button — clears the manual pause immediately for paused leads
  document.querySelectorAll(".leadResetBtn").forEach((btn) => {
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      btn.disabled = true;
      btn.textContent = "Resetting…";

      try {
        await apiFetch(`${API}/leads/${id}/manual-override`, {
          method: "POST",
          body: JSON.stringify({ enabled: false, reason: "Reset by coach" }),
        });

        const lead = allLeads.find((l) => l.id === id);
        if (lead) lead.manual_override = false;

        renderLeadsList();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Reset bot";
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

  // ─── Conversation Activity Stream ────────────────────────────────────────────
  const MAX_ACTIVITY_EVENTS = 60;
  let activityEventSource = null;

  const ACTIVITY_CONFIG = {
    dm_received:          { icon: "💬", iconCls: "activityIcon--blue",   cardCls: "activityEvent--received",  label: "DM received" },
    story_reply_received: { icon: "📸", iconCls: "activityIcon--blue",   cardCls: "activityEvent--received",  label: "Story reply received" },
    opener_sending:       { icon: "→",  iconCls: "activityIcon--yellow", cardCls: "activityEvent--generating", label: "Sending automatic DM" },
    opener_sent:          { icon: "✓",  iconCls: "activityIcon--green",  cardCls: "activityEvent--sent",      label: "DM sent successfully" },
    ai_generating: { icon: "⚡", iconCls: "activityIcon--yellow", cardCls: "activityEvent--generating", label: "AI generating reply" },
    ai_reply_ready:{ icon: "✓",  iconCls: "activityIcon--sky",    cardCls: "activityEvent--ready",      label: "Reply ready" },
    reply_queued:  { icon: "→",  iconCls: "activityIcon--purple", cardCls: "activityEvent--queued",     label: "Reply queued" },
    reply_sent:    { icon: "✓",  iconCls: "activityIcon--green",  cardCls: "activityEvent--sent",       label: "Delivered to Instagram" },
  };

  function fmtActivityTime(isoStr) {
    if (!isoStr) return "";
    const ms = Date.now() - new Date(isoStr).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 5)  return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  function addActivityEvent(event) {
    const feed = qs("#activityFeed");
    if (!feed) return;

    // Remove empty placeholder
    const empty = qs("#activityEmpty");
    if (empty) empty.remove();

    const cfg = ACTIVITY_CONFIG[event.type];
    if (!cfg) return;

    const isPulsing = event.type === "ai_generating" || event.type === "opener_sending";

    // Stop pulsing when the corresponding completion event arrives
    if (event.type === "reply_sent" || event.type === "ai_reply_ready" || event.type === "opener_sent") {
      const gen = feed.querySelector(`.activityEvent--generating[data-psid="${escHtml(event.igPsid || "")}"]`);
      if (gen) gen.querySelector(".activityIcon")?.classList.remove("activityIcon--pulse");
    }

    const el = document.createElement("div");
    el.className = `activityEvent ${cfg.cardCls}`;
    if (event.igPsid) el.dataset.psid = event.igPsid;

    const preview = event.preview
      ? `<div class="activityPreview">${escHtml(String(event.preview).slice(0, 120))}</div>`
      : "";

    el.innerHTML = `
      <div class="activityIcon ${cfg.iconCls}${isPulsing ? " activityIcon--pulse" : ""}">${cfg.icon}</div>
      <div class="activityBody">
        <div class="activityLabel">${cfg.label}</div>
        ${event.leadName ? `<div class="activityLead">${escHtml(event.leadName)}</div>` : ""}
        ${preview}
      </div>
      <div class="activityTime" data-ts="${escHtml(event.ts || "")}">${fmtActivityTime(event.ts)}</div>
    `;

    // Prepend so newest is at the top
    feed.insertBefore(el, feed.firstChild);

    // Cap at max
    const items = feed.querySelectorAll(".activityEvent");
    if (items.length > MAX_ACTIVITY_EVENTS) {
      items[items.length - 1].remove();
    }
  }

  function updateActivityBadge(id, connected) {
    const el = qs(id);
    if (!el) return;
    if (connected) {
      el.className = "asBadge asBadge--green";
    } else {
      el.className = "asBadge asBadge--grey";
    }
  }

  function startActivityTimestampRefresh() {
    setInterval(() => {
      document.querySelectorAll(".activityTime[data-ts]").forEach((el) => {
        el.textContent = fmtActivityTime(el.dataset.ts);
      });
    }, 30000);
  }

  function connectActivityStream() {
    if (activityEventSource) {
      activityEventSource.close();
      activityEventSource = null;
    }

    const token = getToken();
    if (!token) return;

    const url = `${API}/activity-stream?token=${encodeURIComponent(token)}`;
    activityEventSource = new EventSource(url);

    activityEventSource.onopen = () => {
      updateActivityBadge("#asBadgeIg", true);
      updateActivityBadge("#asBadgeAi", true);
    };

    activityEventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "connected") {
          updateActivityBadge("#asBadgeIg", true);
          updateActivityBadge("#asBadgeAi", true);
          return;
        }
        addActivityEvent(event);
      } catch {}
    };

    activityEventSource.onerror = () => {
      updateActivityBadge("#asBadgeIg", false);
      updateActivityBadge("#asBadgeAi", false);
      activityEventSource.close();
      activityEventSource = null;
      // Reconnect after 6 seconds
      setTimeout(connectActivityStream, 6000);
    };
  }

  // ---- Conversation Inbox ----

  let inboxLeadId = null;
  let inboxPollInterval = null;
  let inboxLastMessageCount = 0;

  function fmtMsgTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (isToday) return time;
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return `${date} ${time}`;
  }

  function renderInboxMessages(messages) {
    const container = document.getElementById("inboxMessages");
    if (!container) return;

    if (!messages.length) {
      container.innerHTML = '<div class="inboxEmpty">No messages yet.</div>';
      inboxLastMessageCount = 0;
      return;
    }

    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    const isNewMessages = messages.length !== inboxLastMessageCount;

    container.innerHTML = messages.map((m) => {
      const dir = m.direction === "out" ? "out" : "in";

      if (m.message_type === "story_reply") {
        const hasMedia = !!m.story_media_url;
        const thumbnailHtml = hasMedia
          ? `<img class="storyReplyThumb" src="${escHtml(m.story_media_url)}" alt="Story" loading="lazy">`
          : "";
        const storyLabel = hasMedia
          ? "Replied to your story"
          : "Replied to your story <span class=\"storyExpired\">(story expired)</span>";
        return `<div class="inboxBubbleRow inboxBubbleRow--${dir}">
          <div class="inboxBubble inboxBubble--${dir} inboxBubble--storyReply">
            <div class="storyReplyContext">${thumbnailHtml}<span class="storyReplyLabel">${storyLabel}</span></div>
            ${m.text && m.text !== "[non-text message]" ? `<div class="storyReplyText">${escHtml(m.text)}</div>` : ""}
          </div>
          <div class="inboxTime">${fmtMsgTime(m.created_at)}</div>
        </div>`;
      }

      return `<div class="inboxBubbleRow inboxBubbleRow--${dir}">
        <div class="inboxBubble inboxBubble--${dir}">${escHtml(m.text)}</div>
        <div class="inboxTime">${fmtMsgTime(m.created_at)}</div>
      </div>`;
    }).join("");

    if (wasAtBottom || isNewMessages) {
      container.scrollTop = container.scrollHeight;
    }
    inboxLastMessageCount = messages.length;
  }

  async function loadInboxThread(leadId) {
    if (leadId !== inboxLeadId) return;
    try {
      const data = await apiFetch(`${API}/leads/${leadId}/messages`, { method: "GET" });
      if (!data || leadId !== inboxLeadId) return;
      renderInboxMessages(data.messages || []);
      const note = document.getElementById("inboxRefreshNote");
      if (note) {
        note.textContent = `Updated ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
      }
    } catch (_) {
      // Silently ignore poll errors
    }
  }

  function openInbox(leadId, name, sub) {
    inboxLeadId = leadId;
    inboxLastMessageCount = 0;

    const overlay = document.getElementById("inboxOverlay");
    const panel = document.getElementById("inboxPanel");
    const nameEl = document.getElementById("inboxLeadName");
    const subEl = document.getElementById("inboxLeadSub");
    const msgs = document.getElementById("inboxMessages");
    const input = document.getElementById("inboxInput");

    if (nameEl) nameEl.textContent = name || "Conversation";
    if (subEl) subEl.textContent = sub || "";
    if (msgs) msgs.innerHTML = '<div class="inboxEmpty">Loading…</div>';
    if (input) { input.value = ""; input.disabled = false; }
    if (overlay) overlay.style.display = "block";
    if (panel) panel.style.display = "flex";
    document.body.style.overflow = "hidden";

    loadInboxThread(leadId);
    if (inboxPollInterval) clearInterval(inboxPollInterval);
    inboxPollInterval = setInterval(() => loadInboxThread(inboxLeadId), 5000);
  }

  function closeInbox() {
    inboxLeadId = null;
    if (inboxPollInterval) {
      clearInterval(inboxPollInterval);
      inboxPollInterval = null;
    }
    const overlay = document.getElementById("inboxOverlay");
    const panel = document.getElementById("inboxPanel");
    if (overlay) overlay.style.display = "none";
    if (panel) panel.style.display = "none";
    document.body.style.overflow = "";
  }

  async function sendInboxReply() {
    const leadId = inboxLeadId;
    if (!leadId) return;

    const input = document.getElementById("inboxInput");
    const btn = document.getElementById("inboxSendBtn");
    const text = input ? String(input.value || "").trim() : "";
    if (!text) return;

    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    if (input) input.disabled = true;

    try {
      await apiFetch(`${API}/leads/${leadId}/reply`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      if (input) { input.value = ""; input.disabled = false; input.focus(); }
      await loadInboxThread(leadId);
      // Refresh leads list so the bot-paused badge updates
      loadManualTakeovers().catch(() => {});
    } catch (e) {
      setErr(String(e.message || e));
      if (input) input.disabled = false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Send"; }
    }
  }

  function wireInboxPanel() {
    const closeBtn = document.getElementById("inboxCloseBtn");
    const overlay = document.getElementById("inboxOverlay");
    const sendBtn = document.getElementById("inboxSendBtn");
    const input = document.getElementById("inboxInput");

    if (closeBtn && !closeBtn.__wired) {
      closeBtn.__wired = true;
      closeBtn.addEventListener("click", closeInbox);
    }
    if (overlay && !overlay.__wired) {
      overlay.__wired = true;
      overlay.addEventListener("click", closeInbox);
    }
    if (sendBtn && !sendBtn.__wired) {
      sendBtn.__wired = true;
      sendBtn.addEventListener("click", sendInboxReply);
    }
    if (input && !input.__wired) {
      input.__wired = true;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendInboxReply();
        }
      });
    }
  }

  function wireInboxButtons() {
    document.querySelectorAll(".leadChatBtn").forEach((btn) => {
      if (btn.__wired) return;
      btn.__wired = true;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        const name = btn.getAttribute("data-name");
        const sub = btn.getAttribute("data-sub") || "";
        openInbox(id, name, sub);
      });
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
    wireCommentActivityRefresh();
    wireInboxPanel();

    connectActivityStream();
    startActivityTimestampRefresh();

    await Promise.allSettled([
      loadInstagramConnectionStatus(),
      loadInstagramProfile(),
      loadCommentActivity(),
      loadGlobalPauseStatus(),
      loadManualTakeovers(),
      loadQueueStatus(),
    ]);

    // After OAuth: show success banner and scroll to the profile section
    if (new URLSearchParams(window.location.search).get("instagram_connected") === "1") {
      showIgConnectedBanner();
      // Clean up the URL without reloading
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  function showIgConnectedBanner() {
    // Insert a success notice at the top of the wrap if not already there
    const wrap = document.querySelector(".wrap");
    if (!wrap || document.getElementById("igConnectedBanner")) return;

    const banner = document.createElement("div");
    banner.id = "igConnectedBanner";
    banner.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:10px",
      "padding:14px 18px",
      "border-radius:14px",
      "background:var(--okBg)",
      "border:1px solid var(--okBorder)",
      "color:var(--okText)",
      "font-size:14px",
      "font-weight:650",
      "margin-bottom:18px",
      "animation:activitySlideIn 0.3s ease",
    ].join(";");
    banner.innerHTML = `
      <span style="font-size:18px;">✓</span>
      <span>Instagram account connected successfully. Your profile and recent posts are shown below.</span>
      <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:18px;line-height:1;color:inherit;padding:0 2px;" title="Dismiss">&#x2715;</button>
    `;
    wrap.insertBefore(banner, wrap.firstChild);

    // Scroll the profile card into view
    const profileCard = document.getElementById("igProfileCard");
    if (profileCard && profileCard.style.display !== "none") {
      profileCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Auto-dismiss after 8 seconds
    setTimeout(() => banner.remove(), 8000);
  }


  // Only run dashboard logic when we're actually on a dashboard page.
  // login.html and set-password.html share this script but must not trigger
  // loadDashboard() — that function redirects to login when there is no token,
  // which causes an infinite reload loop on those pages.
  const isAuthPage = !!document.getElementById("loginForm") || !!document.getElementById("setPasswordForm");
  if (!isAuthPage) {
    // If redirected here from Instagram OAuth signup, the token arrives as ?token=...
    // Store it before loadDashboard checks for it, then clean the URL.
    const _oauthParams = new URLSearchParams(window.location.search);
    const _oauthToken = _oauthParams.get("token");
    if (_oauthToken) {
      setToken(_oauthToken);
      _oauthParams.delete("token");
      const _newSearch = _oauthParams.toString();
      window.history.replaceState({}, "", window.location.pathname + (_newSearch ? "?" + _newSearch : ""));
    }

    wireTopbarButtons();
    loadDashboard();
  }
})();
