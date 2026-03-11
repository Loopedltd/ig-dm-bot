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
  function loadInstagramConnectionStatus() {
    const badgeEl = qs("#instagramConnectionBadge");
    const metaEl = qs("#instagramConnectionMeta");
    const btn = qs("#connectInstagramBtn");

    if (!badgeEl || !metaEl || !btn) return;

    badgeEl.className = "badge warn";
    badgeEl.textContent = "Not connected";
    metaEl.textContent = "No Instagram account connected yet.";
    btn.textContent = "Connect Instagram";
    btn.disabled = false;
    btn.style.opacity = "1";
  }

  function wireInstagramConnectButton() {
    const btn = qs("#connectInstagramBtn");
    if (!btn || btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener("click", () => {
      clearErr();
      setErr(
        "Instagram connection is not wired yet. The next step is building the Meta OAuth flow."
      );
    });
  }
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

    wireInstagramConnectButton();
    loadInstagramConnectionStatus();

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
            setErr("Please fill in “How your assistant should reply”.");
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
  }

  wireTopbarButtons();
  loadDashboard();
})();
