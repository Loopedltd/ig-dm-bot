// coach/coach.js

// ✅ Login form handler (login.html has #loginForm)
// If a form exists, we rely on submit only (prevents double-login requests).
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  if (!form) return; // not on login page
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

// coach.js
// Restores old behaviour:
// - Generate Prompt: fills textarea only (no success tick/toast)
// - Save: redirects to /coach/saved.html (the "Saved" page)
// + ✅ Wires Manual Takeovers list + Resume per lead
// + ✅ Wires GLOBAL bot pause
// + ✅ Adds billing portal redirect if button exists
// + ✅ Adds support for public set-password page if present

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

  // ---- LOGIN PAGE ----
  async function initLogin() {
    const emailEl = qs("#email");
    const passEl = qs("#password");
    const loginBtn = qs("#loginBtn");

    if (!emailEl || !passEl || !loginBtn) return;

    // ✅ If there's a real form (#loginForm), submit handler already handles login.
    const form = document.getElementById("loginForm");
    if (form) return;

    if (loginBtn.__wired) return;
    loginBtn.__wired = true;

    if (getToken()) {
      window.location.href = "/coach/dashboard.html";
      return;
    }

    loginBtn.addEventListener("click", async () => {
      try {
        clearErr();
        const email = String(emailEl.value || "").trim().toLowerCase();
        const password = String(passEl.value || "");

        if (!email || !password) {
          setErr("Please enter email + password.");
          return;
        }

        const data = await apiFetch(`${API}/login`, {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });

        if (!data?.token) {
          setErr("Login failed (no token returned).");
          return;
        }

        setToken(data.token);
        window.location.href = "/coach/dashboard.html";
      } catch (e) {
        if (e?.payload?.error === "subscription_inactive") {
          setErr(
            e?.payload?.message ||
              "Subscription inactive. Complete payment before logging in."
          );
          return;
        }
        setErr(String(e.message || e));
      }
    });
  }

  // ---- SET PASSWORD PAGE ----
  function initSetPasswordPage() {
    const form = document.getElementById("setPasswordForm");
    if (!form || form.__wired) return;
    form.__wired = true;

    const passwordEl = document.getElementById("newPassword");
    const confirmEl = document.getElementById("confirmPassword");
    const errEl = document.getElementById("setPasswordError");
    const okEl = document.getElementById("setPasswordOk");
    const submitBtn = document.getElementById("setPasswordBtn");
    const tokenEl = document.getElementById("setupToken");

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") || "";

    if (tokenEl) tokenEl.value = token;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (errEl) {
        errEl.textContent = "";
        errEl.style.display = "none";
      }
      if (okEl) {
        okEl.textContent = "";
        okEl.style.display = "none";
      }

      const password = String(passwordEl?.value || "");
      const confirm = String(confirmEl?.value || "");
      const setupToken = String(tokenEl?.value || "");

      if (!setupToken) {
        if (errEl) {
          errEl.textContent = "Missing setup token.";
          errEl.style.display = "block";
        }
        return;
      }

      if (password.length < 8) {
        if (errEl) {
          errEl.textContent = "Password must be at least 8 characters.";
          errEl.style.display = "block";
        }
        return;
      }

      if (password !== confirm) {
        if (errEl) {
          errEl.textContent = "Passwords do not match.";
          errEl.style.display = "block";
        }
        return;
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.style.opacity = "0.75";
        }

        const res = await fetch("/coach/api/set-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: setupToken,
            password,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data?.error || data?.message || "Failed to set password");
        }

        if (okEl) {
          okEl.textContent = "Password set successfully. Redirecting to login…";
          okEl.style.display = "block";
        }

        setTimeout(() => {
          window.location.href = "https://app.looped.ltd/login?password_set=1";
        }, 900);
      } catch (e2) {
        if (errEl) {
          errEl.textContent = String(e2.message || e2);
          errEl.style.display = "block";
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = "1";
        }
      }
    });
  }

  // =========================
  // ✅ GLOBAL BOT PAUSE (Dashboard)
  // =========================
  async function loadGlobalPauseStatus() {
    const cardEl = qs("#globalPauseCard");
    const badgeEl = qs("#globalPauseBadge");
    const metaEl = qs("#globalPauseMeta");
    const toggleBtn = qs("#toggleGlobalPauseBtn");
    const reasonInput = qs("#globalPauseReason");

    if (!cardEl && !badgeEl && !metaEl && !toggleBtn && !reasonInput) return;

    try {
      const data = await apiFetch(`${API}/bot-paused`, { method: "GET" });
      const s = data?.status || {};
      const paused = !!s.bot_paused;

      if (badgeEl) {
        badgeEl.style.display = "inline-flex";
        badgeEl.textContent = paused ? "Bot paused – global manual mode" : "Bot running";
        badgeEl.classList.toggle("globalPaused", paused);
      }

      if (metaEl) {
        const reason = s.bot_paused_reason ? `Reason: ${s.bot_paused_reason}` : "Reason: —";
        const by = s.bot_paused_by ? `By: ${s.bot_paused_by}` : "By: —";
        const at = `Updated: ${fmtTime(s.bot_paused_at)}`;
        metaEl.textContent = `${reason} • ${by} • ${at}`;
      }

      if (toggleBtn) {
        toggleBtn.dataset.paused = paused ? "1" : "0";
        toggleBtn.textContent = paused ? "Resume bot globally" : "Pause bot globally";
      }
    } catch (e) {
      if (metaEl) {
        metaEl.textContent = `Failed to load global pause status: ${String(e.message || e)}`;
      }
    }
  }

  function wireGlobalPauseButton() {
    const toggleBtn = qs("#toggleGlobalPauseBtn");
    const reasonInput = qs("#globalPauseReason");
    if (!toggleBtn || toggleBtn.__wired) return;
    toggleBtn.__wired = true;

    toggleBtn.addEventListener("click", async () => {
      try {
        clearErr();

        const isPaused = toggleBtn.dataset.paused === "1";
        const next = !isPaused;

        const reasonRaw = reasonInput ? String(reasonInput.value || "").trim() : "";
        const reason =
          reasonRaw ||
          (next ? "Paused globally from dashboard" : "Resumed globally from dashboard");

        toggleBtn.disabled = true;
        toggleBtn.style.opacity = "0.75";

        await apiFetch(`${API}/bot-paused`, {
          method: "POST",
          body: JSON.stringify({ enabled: next, reason }),
        });

        await loadGlobalPauseStatus();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        toggleBtn.disabled = false;
        toggleBtn.style.opacity = "1";
      }
    });
  }

  function wireGlobalPauseRefreshButton() {
    const refreshBtn = qs("#refreshGlobalPauseBtn");
    if (!refreshBtn || refreshBtn.__wired) return;
    refreshBtn.__wired = true;

    refreshBtn.addEventListener("click", async () => {
      try {
        refreshBtn.disabled = true;
        refreshBtn.style.opacity = "0.75";
        await loadGlobalPauseStatus();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.style.opacity = "1";
      }
    });
  }

  // ---- MANUAL TAKEOVERS (Dashboard) ----
  async function loadManualTakeovers() {
    const listEl = qs("#takeoverList");
    const loadingEl = qs("#takeoverLoading");
    const refreshBtn = qs("#refreshTakeoversBtn");

    if (!listEl) return;

    const setLoading = (on) => {
      if (loadingEl) {
        loadingEl.textContent = on ? "Loading…" : "";
        loadingEl.style.display = on ? "block" : "none";
      }
      if (refreshBtn) {
        refreshBtn.disabled = !!on;
        refreshBtn.style.opacity = on ? "0.75" : "1";
      }
    };

    const render = (pausedLeads) => {
      listEl.innerHTML = "";

      if (!pausedLeads.length) {
        const empty = document.createElement("div");
        empty.className = "takeoverMeta";
        empty.textContent = "No paused leads right now.";
        listEl.appendChild(empty);
        return;
      }

      for (const lead of pausedLeads) {
        const row = document.createElement("div");
        row.className = "takeoverRow";

        const left = document.createElement("div");
        left.className = "takeoverLeft";

        const topLine = document.createElement("div");
        topLine.className = "takeoverTopLine";

        const badge = document.createElement("span");
        badge.className = "badge paused";
        badge.textContent = "Bot paused – manual takeover";

        const psid = document.createElement("span");
        psid.className = "mono";
        psid.textContent = `PSID: ${lead.ig_psid || "—"}`;

        topLine.appendChild(badge);
        topLine.appendChild(psid);

        const meta = document.createElement("div");
        meta.className = "takeoverMeta";
        const reason = lead.manual_override_reason
          ? `Reason: ${lead.manual_override_reason}`
          : "Reason: —";
        const by = lead.manual_override_by ? `By: ${lead.manual_override_by}` : "By: —";
        const at = `Last coach activity: ${fmtTime(lead.manual_override_at)}`;
        meta.textContent = `${reason} • ${by} • ${at}`;

        left.appendChild(topLine);
        left.appendChild(meta);

        const right = document.createElement("div");
        right.className = "takeoverRight";

        const resumeBtn = document.createElement("button");
        resumeBtn.className = "btn small primary";
        resumeBtn.textContent = "Resume bot";

        resumeBtn.addEventListener("click", async () => {
          try {
            resumeBtn.disabled = true;
            resumeBtn.style.opacity = "0.75";

            await apiFetch(`${API}/leads/${lead.id}/manual-override`, {
              method: "POST",
              body: JSON.stringify({
                enabled: false,
                reason: "Coach resumed bot from dashboard",
              }),
            });

            await loadManualTakeovers();
          } catch (e) {
            setErr(String(e.message || e));
          } finally {
            resumeBtn.disabled = false;
            resumeBtn.style.opacity = "1";
          }
        });

        right.appendChild(resumeBtn);

        row.appendChild(left);
        row.appendChild(right);

        listEl.appendChild(row);
      }
    };

    try {
      setLoading(true);

      const data = await apiFetch(`${API}/leads`, { method: "GET" });
      const leads = Array.isArray(data?.leads) ? data.leads : [];
      const paused = leads.filter((l) => l && l.manual_override);

      render(paused);
    } catch (e) {
      listEl.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "takeoverMeta";
      errBox.textContent = `Failed to load manual takeovers: ${String(e.message || e)}`;
      listEl.appendChild(errBox);
    } finally {
      setLoading(false);
    }
  }

  function wireManualTakeoversRefreshButton() {
    const refreshBtn = qs("#refreshTakeoversBtn");
    if (!refreshBtn || refreshBtn.__wired) return;
    refreshBtn.__wired = true;

    refreshBtn.addEventListener("click", async () => {
      try {
        await loadManualTakeovers();
      } catch (e) {
        setErr(String(e.message || e));
      }
    });
  }

  function wireBillingPortalButton() {
    const btn = qs("#manageBillingBtn");
    if (!btn || btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener("click", async () => {
      try {
        clearErr();
        btn.disabled = true;
        btn.style.opacity = "0.75";

        const data = await apiFetch(`${API}/billing-portal`, {
          method: "POST",
          body: JSON.stringify({}),
        });

        const url = data?.url;
        if (!url) {
          throw new Error("No billing portal URL returned.");
        }

        window.location.href = url;
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
      }
    });
  }

  // ---- DASHBOARD PAGE ----
  async function loadDashboard() {
    const bookingEl = qs("#booking_url");
    const bookingAltEl = qs("#booking_url_alt");
    const igEl = qs("#instagram_handle");
    const promptEl = qs("#system_prompt");
    const saveBtn = qs("#saveBtn");
    const genBtn = qs("#generatePromptBtn");

    if (!promptEl && !saveBtn && !genBtn) return;

    if (!getToken()) {
      window.location.href = "/coach/login.html";
      return;
    }

    const cfg = await apiFetch(`${API}/config`, { method: "GET" });
    const config = cfg?.config || {};

    if (bookingEl) bookingEl.value = config.booking_url || "";
    if (bookingAltEl) bookingAltEl.value = config.booking_url_alt || "";
    if (igEl) igEl.value = config.instagram_handle || "";
    if (promptEl) promptEl.value = config.system_prompt || "";

    wireGlobalPauseButton();
    wireGlobalPauseRefreshButton();
    loadGlobalPauseStatus().catch(() => {});

    wireManualTakeoversRefreshButton();
    loadManualTakeovers().catch(() => {});

    wireBillingPortalButton();

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
          const system_prompt = promptEl ? String(promptEl.value || "").trim() : "";

          if (!system_prompt) {
            setErr("Please fill in “How your bot should reply”.");
            return;
          }
          if (!isValidUrl(booking_url)) {
            setErr("Booking URL must be a valid http/https link.");
            return;
          }
          if (!isValidUrl(booking_url_alt)) {
            setErr("Alt Booking URL must be a valid http/https link.");
            return;
          }
          if (!isValidIgHandle(instagram_handle)) {
            setErr("Instagram handle looks wrong (use: looped.ltd, no spaces).");
            return;
          }

          saveBtn.disabled = true;
          saveBtn.style.opacity = "0.75";

          const payload = {
            booking_url: booking_url || null,
            booking_url_alt: booking_url_alt || null,
            instagram_handle: instagram_handle || null,
            system_prompt,
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

    if (genBtn && !genBtn.__wired) {
      genBtn.__wired = true;

      genBtn.addEventListener("click", async () => {
        try {
          clearErr();

          const instagram_handle = igEl ? String(igEl.value || "").trim() : "";

          if (!instagram_handle) {
            setErr("Enter an Instagram handle first, then click Generate Prompt.");
            return;
          }
          if (!isValidIgHandle(instagram_handle)) {
            setErr("Instagram handle looks wrong (use: looped.ltd, no spaces).");
            return;
          }

          genBtn.disabled = true;
          genBtn.style.opacity = "0.75";
          genBtn.textContent = "Generating…";

          const data = await apiFetch(`${API}/generate-prompt`, {
            method: "POST",
            body: JSON.stringify({ instagram_handle }),
          });

          const prompt = data?.system_prompt;
          if (!prompt) {
            setErr("No prompt returned. Check server logs.");
            return;
          }

          if (promptEl) promptEl.value = prompt;
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          genBtn.disabled = false;
          genBtn.style.opacity = "1";
          genBtn.textContent = "Generate Prompt";
        }
      });
    }
  }

  // ---- STATS PAGE GUARD ----
  function initStatsGuard() {
    if (window.location.pathname.endsWith("/stats.html")) {
      if (!getToken()) window.location.href = "/coach/login.html";
    }
  }

  wireTopbarButtons();
  initLogin();
  initSetPasswordPage();
  initStatsGuard();

  loadDashboard().catch((e) => {
    try {
      if (e?.payload?.error === "subscription_inactive") {
        clearToken();
        window.location.href = "/coach/login.html?cancelled=1";
        return;
      }
      setErr(String(e.message || e));
    } catch {}
  });
})();
