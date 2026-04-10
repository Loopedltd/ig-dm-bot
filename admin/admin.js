/* global window, document, fetch, localStorage, navigator */

const AdminLogin = {
  async init() {
    const f = document.getElementById("f");
    if (!f) return;

    const btn = document.getElementById("btn");
    const err = document.getElementById("err");
    const ok = document.getElementById("ok");

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (err) err.style.display = "none";
      if (ok) ok.style.display = "none";
      if (btn) btn.disabled = true;

      try {
        const email = document.getElementById("email")?.value?.trim() || "";
        const password = document.getElementById("password")?.value || "";

        const r = await fetch("/admin/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || "Login failed");

        localStorage.setItem("admin_token", j.token);
        if (ok) {
          ok.textContent = "Logged in. Redirecting…";
          ok.style.display = "block";
        }
        window.location.href = "/admin/dashboard.html";
      } catch (e2) {
        if (err) {
          err.textContent = String(e2.message || e2);
          err.style.display = "block";
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  },
};

const AdminDashboard = {
  state: {
    token: null,
    clients: [],
    clientNameById: new Map(),
    selectedClient: null,
    lastPaymentLink: "",
  },

  el(id) {
    return document.getElementById(id);
  },

  authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.state.token}`,
    };
  },

  async apiFetch(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { ...this.authHeaders(), ...(opts.headers || {}) } });
    if (r.status === 401) {
      localStorage.removeItem("admin_token");
      window.location.href = "/admin/login.html";
      return null;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || j?.message || `Request failed (${r.status})`);
    return j;
  },

  fmtDate(s) {
    try {
      return s ? new Date(s).toLocaleString("en-GB") : "";
    } catch {
      return s || "";
    }
  },

  showErr(id, msg) {
    const node = this.el(id);
    if (!node) return;
    node.textContent = msg || "";
    node.style.display = msg ? "block" : "none";
  },

  showOk(id, msg) {
    const node = this.el(id);
    if (!node) return;
    node.textContent = msg || "";
    node.style.display = msg ? "block" : "none";
  },

  requireTokenOrRedirect() {
    const token = localStorage.getItem("admin_token");
    if (!token) {
      window.location.href = "/admin/login.html";
      return false;
    }
    this.state.token = token;
    return true;
  },

  bindLogout() {
    const b = this.el("logoutBtn");
    if (!b) return;
    b.addEventListener("click", () => {
      localStorage.removeItem("admin_token");
      window.location.href = "/admin/login.html";
    });
  },

  bindRefresh() {
    const b = this.el("refreshBtn");
    if (!b) return;
    b.addEventListener("click", () => this.refreshAll());
  },

  bindPaymentLinkBox() {
    const copyBtn = this.el("copyPaymentLinkBtn");
    if (!copyBtn || copyBtn.__wired) return;
    copyBtn.__wired = true;

    copyBtn.addEventListener("click", async () => {
      try {
        if (!this.state.lastPaymentLink) return;
        await navigator.clipboard.writeText(this.state.lastPaymentLink);
        this.showOk("clientsOk", "Payment link copied.");
      } catch {
        this.showErr("clientsErr", "Could not copy payment link.");
      }
    });
  },

  showPaymentLink(url) {
    const box = this.el("paymentLinkBox");
    const text = this.el("paymentLinkText");
    if (!box || !text) return;

    this.state.lastPaymentLink = url || "";
    text.textContent = url || "";
    box.style.display = url ? "flex" : "none";
  },

  openModal() {
    const overlay = this.el("editModal");
    if (!overlay) return;
    overlay.style.display = "flex";
  },

  closeModal() {
    const overlay = this.el("editModal");
    if (!overlay) return;
    overlay.style.display = "none";
    this.showErr("editErr", "");
    this.state.selectedClient = null;
  },

  openCreateClientModal() {
    const overlay = this.el("createClientModal");
    if (!overlay) return;

    this.showErr("createClientErr", "");
    const nameInput = this.el("createClientNameInput");
    const emailInput = this.el("createClientEmailInput");
    const timezoneInput = this.el("createClientTimezoneInput");

    if (nameInput) nameInput.value = "";
    if (emailInput) emailInput.value = "";
    if (timezoneInput) timezoneInput.value = "Europe/London";

    overlay.style.display = "flex";
  },

  closeCreateClientModal() {
    const overlay = this.el("createClientModal");
    if (!overlay) return;
    overlay.style.display = "none";
    this.showErr("createClientErr", "");
  },

  bindModalButtons() {
    const closeBtn = this.el("closeModalBtn");
    closeBtn?.addEventListener("click", () => this.closeModal());

    const cancelBtn = this.el("cancelEditBtn");
    cancelBtn?.addEventListener("click", () => this.closeModal());

    const saveBtn = this.el("saveEditBtn");
    saveBtn?.addEventListener("click", () => this.saveEdit());

    const overlay = this.el("editModal");
    overlay?.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeModal();
    });
  },

  bindCreateClientModalButtons() {
    const openBtn = this.el("createClientBtn");
    openBtn?.addEventListener("click", () => this.openCreateClientModal());

    const closeBtn = this.el("closeCreateClientModalBtn");
    closeBtn?.addEventListener("click", () => this.closeCreateClientModal());

    const cancelBtn = this.el("cancelCreateClientBtn");
    cancelBtn?.addEventListener("click", () => this.closeCreateClientModal());

    const saveBtn = this.el("saveCreateClientBtn");
    saveBtn?.addEventListener("click", () => this.saveCreateClient());

    const overlay = this.el("createClientModal");
    overlay?.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeCreateClientModal();
    });
  },

  getClientConfig(client) {
    const cfg = client?.config;
    if (Array.isArray(cfg)) return cfg[0] || {};
    return cfg || {};
  },

  getBillingStatusPill(cfg) {
    const status = String(cfg?.stripe_subscription_status || "").toLowerCase();

    if (status === "active" || status === "trialing") {
      return { text: status, className: "pill ok" };
    }
    if (status === "past_due" || status === "unpaid") {
      return { text: status, className: "pill warn" };
    }
    if (status === "canceled" || status === "cancelled") {
      return { text: status, className: "pill danger" };
    }
    return { text: status || "not set", className: "pill" };
  },

  openEdit(client) {
    this.state.selectedClient = client;
    this.showErr("editErr", "");

    const title = this.el("editTitle");
    if (title) title.textContent = `Edit: ${client?.name || "Client"}`;

    const cfg = this.getClientConfig(client);

    const bookingUrlInput = this.el("bookingUrlInput");
    const bookingUrlAltInput = this.el("bookingUrlAltInput");
    const systemPromptInput = this.el("systemPromptInput");

    if (bookingUrlInput) bookingUrlInput.value = cfg.booking_url || "";
    if (bookingUrlAltInput) bookingUrlAltInput.value = cfg.booking_url_alt || "";
    if (systemPromptInput) systemPromptInput.value = cfg.system_prompt || "";

    this.openModal();
  },

  async saveEdit() {
    this.showErr("editErr", "");

    const client = this.state.selectedClient;
    if (!client?.id) {
      this.showErr("editErr", "No client selected.");
      return;
    }

    const booking_url = this.el("bookingUrlInput")?.value?.trim() || null;
    const booking_url_alt = this.el("bookingUrlAltInput")?.value?.trim() || null;
    const system_prompt = this.el("systemPromptInput")?.value?.trim() || "";

    const payload = {
      booking_url: booking_url || null,
      booking_url_alt: booking_url_alt || null,
      system_prompt,
    };

    try {
      const j = await this.apiFetch(`/admin/api/clients/${client.id}/config`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!j) return;

      await this.loadClients();
      this.closeModal();
    } catch (e) {
      this.showErr("editErr", String(e.message || e));
    }
  },

  async saveCreateClient() {
    this.showErr("createClientErr", "");

    const name = this.el("createClientNameInput")?.value?.trim() || "";
    const email = this.el("createClientEmailInput")?.value?.trim() || "";
    const timezone = this.el("createClientTimezoneInput")?.value?.trim() || "Europe/London";

    if (!name) {
      this.showErr("createClientErr", "Client name is required.");
      return;
    }

    if (!email) {
      this.showErr("createClientErr", "Coach email is required.");
      return;
    }

    try {
      const j = await this.apiFetch("/admin/api/clients/create", {
        method: "POST",
        body: JSON.stringify({ name, email, timezone }),
      });
      if (!j) return;

      await this.loadClients();
      this.closeCreateClientModal();
      this.showOk("clientsOk", "Client created.");
    } catch (e) {
      this.showErr("createClientErr", String(e.message || e));
    }
  },

  async setBotPaused(clientId, enabled) {
    const j = await this.apiFetch(`/admin/api/clients/${clientId}/bot-paused`, {
      method: "POST",
      body: JSON.stringify({ enabled: !!enabled, reason: enabled ? "Paused by admin" : "Resumed by admin" }),
    });
    if (!j) return null;
    return j;
  },

async createPaymentLink(clientId, email) {
  const j = await this.apiFetch(`/admin/api/create-payment-link/${clientId}`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (!j) return null;
  return j;
},

  async init() {
    if (!this.requireTokenOrRedirect()) return;

    const authStatus = this.el("authStatus");
    if (authStatus) {
      authStatus.textContent = "Auth: OK";
      authStatus.classList.add("ok");
    }

    this.bindLogout();
    this.bindRefresh();
    this.bindModalButtons();
    this.bindCreateClientModalButtons();
    this.bindPaymentLinkBox();

    await this.refreshAll();
  },

  async refreshAll() {
    this.showErr("clientsErr", "");
    this.showErr("leadsErr", "");
    this.showOk("clientsOk", "");
    await this.loadClients();
    await this.loadLeads();
  },

  async loadClients() {
    this.showErr("clientsErr", "");
    this.showOk("clientsOk", "");

    const body = this.el("clientsBody");
    if (body) body.innerHTML = "";

    try {
      const j = await this.apiFetch("/admin/api/clients");
      if (!j) return;

      this.state.clients = j.clients || [];
      this.state.clientNameById = new Map(this.state.clients.map((c) => [c.id, c.name]));

      if (!body) return;

      for (const c of this.state.clients) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.textContent = c.name || "(no name)";
        tr.appendChild(tdName);

        const tdTz = document.createElement("td");
        tdTz.textContent = c.timezone || "";
        tr.appendChild(tdTz);

        const cfg = this.getClientConfig(c);
        const billing = this.getBillingStatusPill(cfg);

        const tdBilling = document.createElement("td");
        const billingPill = document.createElement("span");
        billingPill.className = billing.className;
        billingPill.textContent = billing.text;
        tdBilling.appendChild(billingPill);
        tr.appendChild(tdBilling);

        const tdCreated = document.createElement("td");
        tdCreated.textContent = this.fmtDate(c.created_at);
        tr.appendChild(tdCreated);

        const tdAct = document.createElement("td");
        tdAct.className = "actionsCell";

        const editBtn = document.createElement("button");
        editBtn.className = "btn";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => this.openEdit(c));
        tdAct.appendChild(editBtn);

const payBtn = document.createElement("button");
payBtn.className = "btn secondary";
payBtn.textContent = "Payment link";
payBtn.addEventListener("click", async () => {
  try {
    this.showErr("clientsErr", "");
    this.showOk("clientsOk", "");
    payBtn.disabled = true;

    const email = window.prompt("Enter the coach email for this payment link:");
    if (!email || !email.trim()) {
      throw new Error("Coach email is required to create the payment link.");
    }

    const data = await this.createPaymentLink(c.id, email.trim().toLowerCase());
    const url = data?.url || "";

    if (!url) throw new Error("No payment link returned.");

    this.showPaymentLink(url);

    try {
      await navigator.clipboard.writeText(url);
      this.showOk("clientsOk", "Payment link created and copied.");
    } catch {
      this.showOk("clientsOk", "Payment link created.");
    }
  } catch (e) {
    this.showErr("clientsErr", String(e.message || e));
  } finally {
    payBtn.disabled = false;
  }
});
tdAct.appendChild(payBtn);

        const paused = !!cfg.bot_paused;
        const toggleBtn = document.createElement("button");
        toggleBtn.className = paused ? "btn secondary" : "btn danger";
        toggleBtn.textContent = paused ? "Resume bot" : "Pause bot";

        toggleBtn.addEventListener("click", async () => {
          try {
            toggleBtn.disabled = true;
            const nextPaused = !paused;
            await this.setBotPaused(c.id, nextPaused);
            await this.loadClients();
          } catch (e) {
            this.showErr("clientsErr", String(e.message || e));
          } finally {
            toggleBtn.disabled = false;
          }
        });

        tdAct.appendChild(toggleBtn);
        tr.appendChild(tdAct);

        body.appendChild(tr);
      }
    } catch (e) {
      this.showErr("clientsErr", String(e.message || e));
    }
  },

  async loadLeads() {
    this.showErr("leadsErr", "");

    const body = this.el("leadsBody");
    if (body) body.innerHTML = "";

    try {
      const j = await this.apiFetch("/admin/api/leads");
      if (!j) return;

      const leads = j.leads || [];
      if (!body) return;

      for (const l of leads) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.textContent =
          l.name ||
          this.state.clientNameById.get(l.client_id) ||
          l.ig_psid ||
          "";
        tr.appendChild(tdName);

        const tdStage = document.createElement("td");
        tdStage.textContent = l.stage || "";
        tr.appendChild(tdStage);

        const tdBooking = document.createElement("td");
        tdBooking.textContent = l.booking_sent ? "true" : "false";
        tr.appendChild(tdBooking);

        const tdCall = document.createElement("td");
        tdCall.textContent = l.call_completed ? "true" : "false";
        tr.appendChild(tdCall);

        const tdCreated = document.createElement("td");
        tdCreated.textContent = this.fmtDate(l.created_at);
        tr.appendChild(tdCreated);

        body.appendChild(tr);
      }
    } catch (e) {
      this.showErr("leadsErr", String(e.message || e));
    }
  },
};

window.AdminLogin = AdminLogin;
window.AdminDashboard = AdminDashboard;
