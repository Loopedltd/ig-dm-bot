// admin/admin.js — Admin login + dashboard logic

const TOKEN_KEY = "admin_token";

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?.message || json?.raw || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Admin Login ───────────────────────────────────────────────────────────────

const AdminLogin = {
  init() {
    const form = document.getElementById("f");
    const btn = document.getElementById("btn");
    const errEl = document.getElementById("err");

    if (!form) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.style.display = "none";
      errEl.textContent = "";
      btn.disabled = true;
      btn.textContent = "Signing in...";

      try {
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const data = await apiFetch("/admin/api/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setToken(data.token);
        window.location.href = "/admin/dashboard.html";
      } catch (e) {
        errEl.textContent = e.message || "Login failed";
        errEl.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    });
  },
};

// ── Admin Dashboard ───────────────────────────────────────────────────────────

const AdminDashboard = {
  _clients: [],
  _activeClientId: null,

  init() {
    if (!getToken()) {
      window.location.href = "/admin/login.html";
      return;
    }

    const qs = (id) => document.getElementById(id);

    qs("logoutBtn")?.addEventListener("click", () => {
      clearToken();
      window.location.href = "/admin/login.html";
    });

    qs("refreshBtn")?.addEventListener("click", () => this.loadAll());

    // Create client
    qs("createClientBtn")?.addEventListener("click", () => this.createClient());

    // Config modal
    qs("configCancelBtn")?.addEventListener("click", () => this.closeModal("configModal"));
    qs("configSaveBtn")?.addEventListener("click", () => this.saveConfig());

    // Credentials modal
    qs("credsCancelBtn")?.addEventListener("click", () => this.closeModal("credsModal"));
    qs("credsRevealBtn")?.addEventListener("click", () => this.revealCredentials());

    // Reset password modal
    qs("resetPwCancelBtn")?.addEventListener("click", () => this.closeModal("resetPwModal"));
    qs("resetPwConfirmBtn")?.addEventListener("click", () => this.resetPassword());

    // Close modals on backdrop click
    ["configModal", "credsModal", "resetPwModal"].forEach((id) => {
      const el = qs(id);
      if (el) {
        el.addEventListener("click", (e) => {
          if (e.target === el) this.closeModal(id);
        });
      }
    });

    this.loadAll();
  },

  async loadAll() {
    await Promise.allSettled([this.loadStats(), this.loadClients()]);
  },

  async loadStats() {
    try {
      const data = await apiFetch("/admin/api/stats");
      const s = data?.stats || data || {};
      const qs = (id) => document.getElementById(id);
      if (qs("statClients")) qs("statClients").textContent = s.clients ?? "-";
      if (qs("statLeads")) qs("statLeads").textContent = s.leads ?? "-";
      if (qs("statMessages")) qs("statMessages").textContent = s.messages ?? "-";
    } catch (e) {
      console.warn("stats load failed:", e.message);
    }
  },

  async loadClients() {
    const tbody = document.getElementById("clientTableBody");
    if (!tbody) return;
    try {
      const data = await apiFetch("/admin/api/clients");
      this._clients = data?.clients || [];
      this.renderClientTable();
    } catch (e) {
      if (e.status === 401) { window.location.href = "/admin/login.html"; return; }
      tbody.innerHTML = `<tr><td colspan="6"><div class="emptyState" style="color:#b42318;">Failed to load: ${escHtml(e.message)}</div></td></tr>`;
    }
  },

  renderClientTable() {
    const tbody = document.getElementById("clientTableBody");
    if (!tbody) return;

    if (!this._clients.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="emptyState">No clients yet.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = this._clients.map((c) => {
      const cfg = c.config || {};
      const status = cfg.stripe_subscription_status || "none";
      const badgeCls = status === "active" || status === "trialing" || status === "demo" ? "ok" : status === "past_due" ? "warn" : "off";
      const niche = cfg.niche || "generic";
      return `<tr>
        <td style="font-weight:700;">${escHtml(c.name || "Unnamed")}</td>
        <td class="tdMuted" style="font-family:monospace;font-size:11px;">${escHtml(c.id)}</td>
        <td class="tdMuted">${escHtml(niche)}</td>
        <td><span class="badge ${badgeCls}">${escHtml(status)}</span></td>
        <td class="tdMuted">${escHtml(fmtDate(c.created_at))}</td>
        <td>
          <div class="actionBtns">
            <button class="btn sm" onclick="AdminDashboard.openConfigModal('${escHtml(c.id)}')">Edit config</button>
            <button class="btn sm primary" onclick="AdminDashboard.loginAsCoach('${escHtml(c.id)}', '${escHtml(c.name || "")}')">Access dashboard</button>
            <button class="btn sm" onclick="AdminDashboard.openCredsModal('${escHtml(c.id)}', '${escHtml(c.name || "")}')">Show credentials</button>
            <button class="btn sm danger" onclick="AdminDashboard.openResetPwModal('${escHtml(c.id)}', '${escHtml(c.name || "")}')">Reset password</button>
          </div>
        </td>
      </tr>`;
    }).join("");
  },

  // ── Create client ──────────────────────────────────────────────────────────

  async createClient() {
    const qs = (id) => document.getElementById(id);
    const name = (qs("newName")?.value || "").trim();
    const email = (qs("newEmail")?.value || "").trim();
    const errEl = qs("createErr");
    const okEl = qs("createOk");

    if (errEl) { errEl.textContent = ""; errEl.style.display = "none"; }
    if (okEl) { okEl.textContent = ""; okEl.style.display = "none"; }

    if (!name) { if (errEl) { errEl.textContent = "Name is required."; errEl.style.display = "inline"; } return; }
    if (!email) { if (errEl) { errEl.textContent = "Email is required."; errEl.style.display = "inline"; } return; }

    const btn = qs("createClientBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }

    try {
      const data = await apiFetch("/admin/api/clients/create", {
        method: "POST",
        body: JSON.stringify({ name, email }),
      });
      if (okEl) { okEl.textContent = `Created: ${data.client?.id || "ok"}. Send password setup link to the coach.`; okEl.style.display = "inline"; }
      if (qs("newName")) qs("newName").value = "";
      if (qs("newEmail")) qs("newEmail").value = "";
      await this.loadClients();
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || "Create failed."; errEl.style.display = "inline"; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Create client"; }
    }
  },

  // ── Config modal ───────────────────────────────────────────────────────────

  openConfigModal(clientId) {
    const client = this._clients.find((c) => c.id === clientId);
    if (!client) return;
    this._activeClientId = clientId;
    const cfg = client.config || {};

    const qs = (id) => document.getElementById(id);
    if (qs("configModalSub")) qs("configModalSub").textContent = client.name || clientId;
    if (qs("cfgSystemPrompt")) qs("cfgSystemPrompt").value = cfg.system_prompt || "";
    if (qs("cfgNiche")) qs("cfgNiche").value = cfg.niche || "generic";
    if (qs("cfgTone")) qs("cfgTone").value = cfg.tone || "";
    if (qs("cfgStyle")) qs("cfgStyle").value = cfg.style || "";
    if (qs("cfgBookingUrl")) qs("cfgBookingUrl").value = cfg.booking_url || "";
    if (qs("cfgOfferPrice")) qs("cfgOfferPrice").value = cfg.offer_price || "";
    if (qs("cfgStripeStatus")) qs("cfgStripeStatus").value = cfg.stripe_subscription_status || "";
    if (qs("configErr")) { qs("configErr").textContent = ""; qs("configErr").style.display = "none"; }
    if (qs("configOk")) { qs("configOk").textContent = ""; qs("configOk").style.display = "none"; }

    this.openModal("configModal");
  },

  async saveConfig() {
    const clientId = this._activeClientId;
    if (!clientId) return;

    const qs = (id) => document.getElementById(id);
    const errEl = qs("configErr");
    const okEl = qs("configOk");
    const btn = qs("configSaveBtn");

    if (errEl) { errEl.style.display = "none"; }
    if (okEl) { okEl.style.display = "none"; }
    if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }

    try {
      await apiFetch(`/admin/api/clients/${clientId}/config`, {
        method: "POST",
        body: JSON.stringify({
          system_prompt: qs("cfgSystemPrompt")?.value || null,
          niche: qs("cfgNiche")?.value || null,
          tone: qs("cfgTone")?.value || null,
          style: qs("cfgStyle")?.value || null,
          booking_url: qs("cfgBookingUrl")?.value || null,
          offer_price: qs("cfgOfferPrice")?.value || null,
          stripe_subscription_status: qs("cfgStripeStatus")?.value || null,
        }),
      });
      if (okEl) { okEl.textContent = "Saved."; okEl.style.display = "block"; }
      // Update local cache
      const client = this._clients.find((c) => c.id === clientId);
      if (client) {
        client.config = client.config || {};
        client.config.system_prompt = qs("cfgSystemPrompt")?.value || null;
        client.config.niche = qs("cfgNiche")?.value || null;
        client.config.tone = qs("cfgTone")?.value || null;
        client.config.style = qs("cfgStyle")?.value || null;
        client.config.booking_url = qs("cfgBookingUrl")?.value || null;
        client.config.offer_price = qs("cfgOfferPrice")?.value || null;
        client.config.stripe_subscription_status = qs("cfgStripeStatus")?.value || null;
        this.renderClientTable();
      }
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || "Save failed."; errEl.style.display = "block"; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save changes"; }
    }
  },

  // ── Login as coach ─────────────────────────────────────────────────────────

  async loginAsCoach(clientId, clientName) {
    try {
      const data = await apiFetch(`/admin/api/clients/${clientId}/login-token`, { method: "POST" });
      const coachToken = data.token;
      // Store under coach token key and open dashboard in new tab
      const win = window.open("/dashboard", "_blank");
      if (!win) {
        alert("Pop-up blocked. Please allow pop-ups for this site.");
        return;
      }
      // The new tab needs the token — inject it via localStorage on the same origin
      // We do this by navigating to a helper URL that sets the token
      win.addEventListener("load", () => {
        try {
          win.localStorage.setItem("coach_token", coachToken);
          win.location.reload();
        } catch (e) {
          // If blocked, write token to sessionStorage as fallback
          console.warn("Could not inject token into new tab:", e);
        }
      }, { once: true });
      // Fallback: store in sessionStorage here and pass via postMessage
      setTimeout(() => {
        try {
          win.postMessage({ type: "admin_inject_token", coach_token: coachToken }, window.location.origin);
        } catch {}
      }, 1000);
    } catch (e) {
      alert("Failed to get login token: " + (e.message || e));
    }
  },

  // ── Show credentials ───────────────────────────────────────────────────────

  openCredsModal(clientId, clientName) {
    this._activeClientId = clientId;
    const qs = (id) => document.getElementById(id);
    if (qs("credsModalSub")) qs("credsModalSub").textContent = `Credentials for: ${clientName || clientId}`;
    if (qs("masterPasswordInput")) qs("masterPasswordInput").value = "";
    if (qs("credsErr")) { qs("credsErr").textContent = ""; qs("credsErr").style.display = "none"; }
    if (qs("credReveal")) qs("credReveal").style.display = "none";
    this.openModal("credsModal");
  },

  async revealCredentials() {
    const clientId = this._activeClientId;
    if (!clientId) return;
    const qs = (id) => document.getElementById(id);
    const masterPw = qs("masterPasswordInput")?.value || "";
    const errEl = qs("credsErr");
    const revealEl = qs("credReveal");

    if (errEl) { errEl.style.display = "none"; }
    if (!masterPw) { if (errEl) { errEl.textContent = "Enter the master password."; errEl.style.display = "block"; } return; }

    const btn = qs("credsRevealBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Checking..."; }

    try {
      const data = await apiFetch(`/admin/api/clients/${clientId}/credentials`, {
        method: "POST",
        body: JSON.stringify({ master_password: masterPw }),
      });
      if (qs("credEmail")) qs("credEmail").textContent = data.email || "(no email found)";
      if (qs("credNote")) qs("credNote").textContent = data.note || "";
      if (revealEl) revealEl.style.display = "block";
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || "Incorrect password."; errEl.style.display = "block"; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Reveal"; }
    }
  },

  // ── Reset password ─────────────────────────────────────────────────────────

  openResetPwModal(clientId, clientName) {
    this._activeClientId = clientId;
    const qs = (id) => document.getElementById(id);
    if (qs("resetPwModalSub")) qs("resetPwModalSub").textContent = `Generate a new password for ${clientName || clientId}.`;
    if (qs("resetPwErr")) { qs("resetPwErr").textContent = ""; qs("resetPwErr").style.display = "none"; }
    if (qs("resetPwReveal")) qs("resetPwReveal").style.display = "none";
    if (qs("resetPwConfirmBtn")) { qs("resetPwConfirmBtn").disabled = false; qs("resetPwConfirmBtn").textContent = "Generate new password"; }
    this.openModal("resetPwModal");
  },

  async resetPassword() {
    const clientId = this._activeClientId;
    if (!clientId) return;
    const qs = (id) => document.getElementById(id);
    const errEl = qs("resetPwErr");
    const revealEl = qs("resetPwReveal");
    const btn = qs("resetPwConfirmBtn");

    if (errEl) { errEl.style.display = "none"; }
    if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }

    try {
      const data = await apiFetch(`/admin/api/clients/${clientId}/reset-password`, { method: "POST" });
      if (qs("resetPwEmail")) qs("resetPwEmail").textContent = data.email || "";
      if (qs("resetPwPassword")) qs("resetPwPassword").textContent = data.new_password || "";
      if (revealEl) revealEl.style.display = "block";
      if (btn) { btn.disabled = true; btn.textContent = "Done"; }
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || "Reset failed."; errEl.style.display = "block"; }
      if (btn) { btn.disabled = false; btn.textContent = "Generate new password"; }
    }
  },

  // ── Modal helpers ──────────────────────────────────────────────────────────

  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("open");
  },

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
  },
};
