// coach/leads.js — Leads data page logic

(function () {
  const API = "/coach/api";
  const TOKEN_KEY = "coach_token";

  const qs = (sel) => document.querySelector(sel);

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  }

  function stageFmt(stage) {
    if (!stage) return "—";
    return stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function leadDisplayName(lead) {
    if (lead.ig_name) return lead.ig_name;
    if (lead.email) return lead.email;
    const psid = String(lead.ig_psid || "");
    return psid ? `User ${psid.slice(-6)}` : "Unknown";
  }

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

  let allLeads = [];

  function getFiltered() {
    const search = String(qs("#searchInput")?.value || "").trim().toLowerCase();
    const stage = String(qs("#stageFilter")?.value || "");
    const botStatus = String(qs("#botStatusFilter")?.value || "");

    return allLeads.filter((lead) => {
      if (stage && lead.stage !== stage) return false;
      if (botStatus === "active" && lead.manual_override) return false;
      if (botStatus === "paused" && !lead.manual_override) return false;
      if (search) {
        const name = leadDisplayName(lead).toLowerCase();
        const email = String(lead.email || "").toLowerCase();
        const phone = String(lead.phone || "").toLowerCase();
        const psid = String(lead.ig_psid || "").toLowerCase();
        if (!name.includes(search) && !email.includes(search) && !phone.includes(search) && !psid.includes(search)) return false;
      }
      return true;
    });
  }

  function renderTable() {
    const tbody = qs("#leadsTableBody");
    const countEl = qs("#leadCount");
    if (!tbody) return;

    const leads = getFiltered();
    if (countEl) countEl.textContent = `${leads.length} lead${leads.length !== 1 ? "s" : ""}`;

    if (!leads.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="emptyState">No leads found.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = leads.map((lead) => {
      const name = leadDisplayName(lead);
      const email = lead.email || "—";
      const phone = lead.phone || "—";
      const stage = stageFmt(lead.stage);
      const lastMsg = fmtDate(lead.last_inbound_at || lead.last_outbound_at || lead.created_at);
      const paused = !!lead.manual_override;
      const botBadge = paused
        ? `<span class="badge paused">Paused</span>`
        : `<span class="badge active">Active</span>`;

      return `<tr>
        <td style="font-weight:600;">${escHtml(name)}</td>
        <td class="${email === "—" ? "tdMuted" : ""}">${escHtml(email)}</td>
        <td class="${phone === "—" ? "tdMuted" : ""}">${escHtml(phone)}</td>
        <td class="tdMuted">${escHtml(stage)}</td>
        <td class="tdMuted">${escHtml(lastMsg)}</td>
        <td>${botBadge}</td>
      </tr>`;
    }).join("");
  }

  function escHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function refreshNames() {
    const btn = qs("#refreshNamesBtn");
    const statusEl = qs("#refreshNamesStatus");
    if (!btn) return;

    btn.disabled = true;
    btn.style.opacity = "0.65";
    btn.textContent = "Refreshing…";
    if (statusEl) { statusEl.textContent = "Looking up Instagram names — this may take a moment…"; statusEl.style.display = "block"; statusEl.style.color = "rgba(15,23,42,0.55)"; }

    try {
      const data = await apiFetch(`${API}/leads/refresh-names`, { method: "POST" });
      if (statusEl) {
        statusEl.textContent = data?.message || `Updated ${data?.updated ?? 0} leads.`;
        statusEl.style.color = "#027a48";
      }
      // Reload table to show new names
      await loadLeads();
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = "Error: " + String(e.message || e);
        statusEl.style.color = "#c0262d";
        statusEl.style.display = "block";
      }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = "1"; btn.textContent = "Refresh names"; }
    }
  }

  async function loadLeads() {
    const tbody = qs("#leadsTableBody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="loadingState">Loading leads…</div></td></tr>`;
    try {
      const data = await apiFetch(`${API}/leads`);
      allLeads = data?.leads || [];
      renderTable();
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="emptyState" style="color:#c0262d;">Failed to load leads: ${escHtml(String(e.message || e))}</div></td></tr>`;
    }
  }

  function exportCsv() {
    const leads = getFiltered();
    const headers = ["Name", "Email", "Phone", "Stage", "Last Message", "Bot Status", "Instagram PSID", "Created"];
    const rows = leads.map((lead) => [
      leadDisplayName(lead),
      lead.email || "",
      lead.phone || "",
      lead.stage || "",
      lead.last_inbound_at || lead.last_outbound_at || lead.created_at || "",
      lead.manual_override ? "Paused" : "Active",
      lead.ig_psid || "",
      lead.created_at || "",
    ]);

    const csvLines = [headers, ...rows].map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    );

    const csv = csvLines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!getToken()) {
      window.location.href = "/coach/login.html";
      return;
    }

    const logoutBtn = qs("#logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        clearToken();
        window.location.href = "/coach/login.html";
      });
    }

    const exportBtn = qs("#exportCsvBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", exportCsv);
    }

    const refreshNamesBtn = qs("#refreshNamesBtn");
    if (refreshNamesBtn) {
      refreshNamesBtn.addEventListener("click", refreshNames);
    }

    const searchInput = qs("#searchInput");
    const stageFilter = qs("#stageFilter");
    const botStatusFilter = qs("#botStatusFilter");

    if (searchInput) searchInput.addEventListener("input", renderTable);
    if (stageFilter) stageFilter.addEventListener("change", renderTable);
    if (botStatusFilter) botStatusFilter.addEventListener("change", renderTable);

    await loadLeads();
  });
})();
