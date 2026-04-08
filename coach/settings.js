// coach/settings.js — Settings page logic

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

  function setErr(msg) {
    const err = qs("#err");
    const ok = qs("#ok");
    if (ok) ok.style.display = "none";
    if (!err) return;
    err.textContent = msg;
    err.style.display = "block";
  }

  function clearErr() {
    const err = qs("#err");
    if (!err) return;
    err.textContent = "";
    err.style.display = "none";
  }

  function showOk(msg) {
    const ok = qs("#ok");
    const err = qs("#err");
    if (err) err.style.display = "none";
    if (!ok) return;
    ok.textContent = msg || "Settings saved ✓";
    ok.style.display = "block";
    setTimeout(() => { if (ok) ok.style.display = "none"; }, 3500);
  }

  function isValidUrl(str) {
    if (!str) return true;
    try {
      const u = new URL(str);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch { return false; }
  }

  function isValidIgHandle(str) {
    if (!str) return true;
    const s = String(str).trim();
    const h = s.startsWith("@") ? s.slice(1) : s;
    return /^[a-zA-Z0-9._]{1,30}$/.test(h);
  }

  function getTimeUntilTomorrow() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    const diffMs = tomorrow.getTime() - now.getTime();
    const totalMinutes = Math.max(0, Math.floor(diffMs / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
  }

  function parseExampleMessages(raw) {
    const text = String(raw || "").trim();
    if (!text) return { ok: true, value: "" };
    const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const cleaned = [];
    for (const block of blocks) {
      const match = block.match(/user:\s*([\s\S]*?)\nassistant:\s*([\s\S]*)/i);
      if (!match) {
        return { ok: false, error: "Example messages format is invalid.\n\nUse:\nuser: ...\nassistant: ..." };
      }
      const user = String(match[1] || "").trim();
      const assistant = String(match[2] || "").trim();
      if (!user || !assistant) {
        return { ok: false, error: "Each example must include both a user line and an assistant line." };
      }
      cleaned.push(`user: ${user}\nassistant: ${assistant}`);
    }
    return { ok: true, value: cleaned.join("\n\n") };
  }

  function buildStructuredCoachContext({
    offer_what = "", offer_features = "", offer_audience = "", offer_process = "",
    main_result = "", best_fit_leads = "", not_a_fit = "", common_objections = "",
    closing_triggers = "", urgency_reason = "", trust_builders = "", faq = "",
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
      err.payload = json;
      throw err;
    }
    return json;
  }

  // ── Badge helpers ──────────────────────────────────────────────────────────

  function syncBadge(badgeId, selectId, labelOn, labelOff) {
    const badge = qs(`#${badgeId}`);
    const sel = qs(`#${selectId}`);
    if (!badge || !sel) return;
    const refresh = () => {
      const on = String(sel.value) === "true";
      badge.textContent = on ? labelOn : labelOff;
      badge.className = on ? "badge connected" : "badge";
    };
    refresh();
    if (!sel.__badgeWired) {
      sel.__badgeWired = true;
      sel.addEventListener("change", refresh);
    }
  }

  function wireBadges() {
    syncBadge("storyReplyToggleBadge", "story_reply_auto_dm_enabled", "Story reply ON", "Story reply OFF");
    syncBadge("commentReplyToggleBadge", "comment_reply_auto_dm_enabled", "Comment reply ON", "Comment reply OFF");
    syncBadge("keywordToggleBadge", "keyword_auto_dm_enabled", "Keyword DM ON", "Keyword DM OFF");
    syncBadge("commentKeywordToggleBadge", "comment_keyword_dm_enabled", "On", "Off");
    const badge = qs("#contactCollectionBadge");
    const sel = qs("#contact_collection_enabled");
    if (badge && sel) {
      const refresh = () => {
        const on = String(sel.value) === "true";
        badge.textContent = on ? "On" : "Off";
        badge.className = on ? "badge connected" : "badge";
      };
      refresh();
      if (!sel.__badgeWired) {
        sel.__badgeWired = true;
        sel.addEventListener("change", refresh);
      }
    }
  }

  // ── Load config into form ─────────────────────────────────────────────────

  function val(el, v) {
    if (!el) return;
    if (el.tagName === "SELECT") {
      el.value = v === true || v === "true" ? "true" : v === false || v === "false" ? "false" : (v ?? "");
    } else {
      el.value = v ?? "";
    }
  }

  async function loadConfig() {
    try {
      const data = await apiFetch(`${API}/config`);
      const c = data?.config || {};

      // Triggers
      val(qs("#story_reply_auto_dm_enabled"), c.story_reply_auto_dm_enabled);
      val(qs("#story_reply_auto_dm_text"), c.story_reply_auto_dm_text);
      val(qs("#comment_reply_auto_dm_enabled"), c.comment_reply_auto_dm_enabled);
      val(qs("#comment_reply_auto_dm_text"), c.comment_reply_auto_dm_text);
      val(qs("#keyword_auto_dm_enabled"), c.keyword_auto_dm_enabled);
      val(qs("#keyword_trigger_text"), c.keyword_trigger_text);
      val(qs("#keyword_auto_dm_text"), c.keyword_auto_dm_text);

      // Comment keyword
      val(qs("#comment_keyword_dm_enabled"), c.comment_keyword_dm_enabled);
      val(qs("#comment_keyword_trigger"), c.comment_keyword_trigger);
      val(qs("#comment_keyword_dm_text"), c.comment_keyword_dm_text);
      val(qs("#comment_keyword_reply_enabled"), c.comment_keyword_reply_enabled);
      val(qs("#comment_keyword_reply_text"), c.comment_keyword_reply_text);

      // Contact collection
      val(qs("#contact_collection_enabled"), c.contact_collection_enabled);

      // Booking & offer
      val(qs("#booking_url"), c.booking_url);
      val(qs("#booking_url_alt"), c.booking_url_alt);
      val(qs("#offer_what"), c.what_you_do);
      val(qs("#offer_features"), c.what_they_get);
      val(qs("#offer_audience"), c.who_its_for);
      val(qs("#offer_process"), c.how_it_works);

      // Advanced
      val(qs("#main_result"), c.main_result);
      val(qs("#best_fit_leads"), c.best_fit_leads);
      val(qs("#not_a_fit"), c.not_a_fit);
      val(qs("#common_objections"), c.common_objections);
      val(qs("#closing_triggers"), c.closing_triggers);
      val(qs("#urgency_reason"), c.urgency_reason);
      val(qs("#trust_builders"), c.trust_builders);
      val(qs("#faq"), c.faq);
      val(qs("#offer_price"), c.offer_price);

      // AI customisation
      val(qs("#instagram_handle"), c.instagram_handle);
      val(qs("#niche"), c.niche || "generic");
      val(qs("#tone"), c.tone);
      val(qs("#style"), c.style);
      val(qs("#vocabulary"), c.vocabulary);
      val(qs("#system_prompt"), c.system_prompt);
      if (c.example_messages) val(qs("#example_messages"), c.example_messages);

    } catch (e) {
      setErr("Failed to load settings: " + String(e.message || e));
    }
  }

  // ── Instagram connection ──────────────────────────────────────────────────

  async function loadInstagramConnectionStatus() {
    const badgeEl = qs("#instagramConnectionBadge");
    const metaEl = qs("#instagramConnectionMeta");
    const btn = qs("#connectInstagramBtn");
    if (!badgeEl || !metaEl || !btn) return;

    try {
      const data = await apiFetch(`${API}/instagram/status`);
      if (data?.connected) {
        badgeEl.className = "badge connected";
        badgeEl.textContent = "Connected";
        metaEl.textContent = data.username ? `Connected as @${data.username}` : "Instagram connected";
        btn.textContent = "Reconnect Instagram";
      } else {
        badgeEl.className = "badge warn";
        badgeEl.textContent = "Not connected";
        metaEl.textContent = "No Instagram account connected yet.";
        btn.textContent = "Connect Instagram";
      }
    } catch {
      badgeEl.className = "badge warn";
      badgeEl.textContent = "Error";
      metaEl.textContent = "Failed to load Instagram status.";
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
        const data = await apiFetch(`${API}/instagram/connect-url`);
        if (!data?.url) throw new Error("Missing Instagram connect URL");
        window.location.href = data.url;
      } catch (e) {
        setErr(String(e.message || e));
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.textContent = "Connect Instagram";
      }
    });
  }

  // ── Generate prompt ───────────────────────────────────────────────────────

  async function loadPromptUsageStatus() {
    const el = qs("#promptLimitStatus");
    if (!el) return;
    try {
      const data = await apiFetch(`${API}/prompt-usage`);
      const remaining = Number(data?.remaining ?? 0);
      const max = Number(data?.max ?? 10);
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
      el.textContent = remaining > 0
        ? `${remaining} / ${max} prompt generations left today (resets in ${resetTime})`
        : `Limit reached — resets in ${resetTime}`;
      el.style.color = remaining <= 2 ? "#b54708" : "var(--muted)";
    } catch {
      el.textContent = "Could not load prompt usage";
      el.style.color = "#c0262d";
    }
  }

  function wireGeneratePromptButton() {
    const btn = qs("#generatePromptBtn");
    if (!btn || btn.__wired) return;
    btn.__wired = true;

    const promptStatusEl = qs("#promptStatus");

    btn.addEventListener("click", async () => {
      try {
        clearErr();
        if (promptStatusEl) promptStatusEl.textContent = "";

        const instagram_handle = String(qs("#instagram_handle")?.value || "").trim();
        if (!instagram_handle) { setErr("Enter your Instagram handle first."); return; }
        if (!isValidIgHandle(instagram_handle)) { setErr("Instagram handle format is invalid."); return; }

        const story_reply_auto_dm_enabled = String(qs("#story_reply_auto_dm_enabled")?.value || "false") === "true";
        const story_reply_auto_dm_text = String(qs("#story_reply_auto_dm_text")?.value || "").trim();
        const comment_reply_auto_dm_enabled = String(qs("#comment_reply_auto_dm_enabled")?.value || "false") === "true";
        const comment_reply_auto_dm_text = String(qs("#comment_reply_auto_dm_text")?.value || "").trim();
        const keyword_auto_dm_enabled = String(qs("#keyword_auto_dm_enabled")?.value || "false") === "true";
        const keyword_trigger_text = String(qs("#keyword_trigger_text")?.value || "").trim();
        const keyword_auto_dm_text = String(qs("#keyword_auto_dm_text")?.value || "").trim();

        if (story_reply_auto_dm_enabled && !story_reply_auto_dm_text) {
          setErr("Add the story reply outbound message or turn Story reply auto-DM off."); return;
        }
        if (comment_reply_auto_dm_enabled && !comment_reply_auto_dm_text) {
          setErr("Add the comment reply outbound message or turn Comment reply auto-DM off."); return;
        }
        if (keyword_auto_dm_enabled && !keyword_trigger_text) {
          setErr("Add the trigger phrase or turn Keyword auto-DM off."); return;
        }
        if (keyword_auto_dm_enabled && !keyword_auto_dm_text) {
          setErr("Add the keyword outbound message or turn Keyword auto-DM off."); return;
        }

        const offer_what = String(qs("#offer_what")?.value || "").trim();
        const offer_features = String(qs("#offer_features")?.value || "").trim();
        const offer_audience = String(qs("#offer_audience")?.value || "").trim();
        const offer_process = String(qs("#offer_process")?.value || "").trim();
        const main_result = String(qs("#main_result")?.value || "").trim();
        const best_fit_leads = String(qs("#best_fit_leads")?.value || "").trim();
        const not_a_fit = String(qs("#not_a_fit")?.value || "").trim();
        const common_objections = String(qs("#common_objections")?.value || "").trim();
        const closing_triggers = String(qs("#closing_triggers")?.value || "").trim();
        const urgency_reason = String(qs("#urgency_reason")?.value || "").trim();
        const trust_builders = String(qs("#trust_builders")?.value || "").trim();
        const faq = String(qs("#faq")?.value || "").trim();
        const offer_price = String(qs("#offer_price")?.value || "").trim();
        const example_messages = String(qs("#example_messages")?.value || "").trim();
        const niche = String(qs("#niche")?.value || "generic").trim();

        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.textContent = "Generating...";
        if (promptStatusEl) promptStatusEl.textContent = "Generating coach voice from your settings...";

        const offer_description = buildStructuredCoachContext({
          offer_what, offer_features, offer_audience, offer_process, main_result,
          best_fit_leads, not_a_fit, common_objections, closing_triggers,
          urgency_reason, trust_builders, faq,
        });

        const data = await apiFetch(`${API}/generate-prompt`, {
          method: "POST",
          body: JSON.stringify({
            instagram_handle, niche, example_messages, offer_description, offer_price,
            what_you_do: offer_what, what_they_get: offer_features,
            who_its_for: offer_audience, how_it_works: offer_process,
            main_result, best_fit_leads, not_a_fit, common_objections,
            closing_triggers, urgency_reason, trust_builders, faq,
          }),
        });

        const promptEl = qs("#system_prompt");
        if (promptEl && data?.system_prompt) promptEl.value = data.system_prompt;

        if (promptStatusEl) {
          const tone = data?.tone || "direct";
          const style = data?.style || "short, punchy";
          const vocabulary = data?.vocabulary || "casual";
          const remaining = Number(data?.remaining ?? 0);
          promptStatusEl.textContent = `Updated. Tone: ${tone}. Style: ${style}. Vocabulary: ${vocabulary}. ${remaining} left today.`;
        }

        await loadPromptUsageStatus();
      } catch (e) {
        setErr(String(e.message || e));
        const promptStatusEl = qs("#promptStatus");
        if (promptStatusEl) {
          promptStatusEl.textContent = String(e.message || "").includes("daily_limit_reached")
            ? "Daily prompt limit reached." : "Failed to generate prompt.";
        }
        await loadPromptUsageStatus();
      } finally {
        const b = qs("#generatePromptBtn");
        if (b) { b.disabled = false; b.style.opacity = "1"; }
      }
    });
  }

  // ── Save settings ─────────────────────────────────────────────────────────

  function wireSaveButton() {
    const btn = qs("#saveBtn");
    if (!btn || btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener("click", async () => {
      try {
        clearErr();

        const booking_url = String(qs("#booking_url")?.value || "").trim();
        const booking_url_alt = String(qs("#booking_url_alt")?.value || "").trim();
        const instagram_handle = String(qs("#instagram_handle")?.value || "").trim();

        if (!isValidUrl(booking_url)) { setErr("Booking URL is not a valid URL."); return; }
        if (!isValidUrl(booking_url_alt)) { setErr("Alt Booking URL is not a valid URL."); return; }
        if (!isValidIgHandle(instagram_handle)) { setErr("Instagram handle format is invalid (letters, numbers, dots, underscores, max 30 chars)."); return; }

        const story_reply_auto_dm_enabled = String(qs("#story_reply_auto_dm_enabled")?.value || "false") === "true";
        const story_reply_auto_dm_text = String(qs("#story_reply_auto_dm_text")?.value || "").trim();
        const comment_reply_auto_dm_enabled = String(qs("#comment_reply_auto_dm_enabled")?.value || "false") === "true";
        const comment_reply_auto_dm_text = String(qs("#comment_reply_auto_dm_text")?.value || "").trim();
        const keyword_auto_dm_enabled = String(qs("#keyword_auto_dm_enabled")?.value || "false") === "true";
        const keyword_trigger_text = String(qs("#keyword_trigger_text")?.value || "").trim();
        const keyword_auto_dm_text = String(qs("#keyword_auto_dm_text")?.value || "").trim();

        if (story_reply_auto_dm_enabled && !story_reply_auto_dm_text) {
          setErr("Add the story reply outbound message or turn Story reply auto-DM off."); return;
        }
        if (comment_reply_auto_dm_enabled && !comment_reply_auto_dm_text) {
          setErr("Add the comment reply outbound message or turn Comment reply auto-DM off."); return;
        }
        if (keyword_auto_dm_enabled && !keyword_trigger_text) {
          setErr("Add the trigger phrase or turn Keyword auto-DM off."); return;
        }
        if (keyword_auto_dm_enabled && !keyword_auto_dm_text) {
          setErr("Add the keyword outbound message or turn Keyword auto-DM off."); return;
        }

        const examplesRaw = String(qs("#example_messages")?.value || "").trim();
        const exParsed = parseExampleMessages(examplesRaw);
        if (!exParsed.ok) { setErr(exParsed.error); return; }

        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.textContent = "Saving...";

        await apiFetch(`${API}/config`, {
          method: "POST",
          body: JSON.stringify({
            booking_url: booking_url || null,
            booking_url_alt: booking_url_alt || null,
            instagram_handle: instagram_handle || null,
            story_reply_auto_dm_enabled,
            story_reply_auto_dm_text: story_reply_auto_dm_text || null,
            comment_reply_auto_dm_enabled,
            comment_reply_auto_dm_text: comment_reply_auto_dm_text || null,
            keyword_auto_dm_enabled,
            keyword_trigger_text: keyword_trigger_text || null,
            keyword_auto_dm_text: keyword_auto_dm_text || null,
            comment_keyword_dm_enabled: String(qs("#comment_keyword_dm_enabled")?.value || "false") === "true",
            comment_keyword_trigger: String(qs("#comment_keyword_trigger")?.value || "").trim() || null,
            comment_keyword_dm_text: String(qs("#comment_keyword_dm_text")?.value || "").trim() || null,
            comment_keyword_reply_enabled: String(qs("#comment_keyword_reply_enabled")?.value || "false") === "true",
            comment_keyword_reply_text: String(qs("#comment_keyword_reply_text")?.value || "").trim() || null,
            contact_collection_enabled: String(qs("#contact_collection_enabled")?.value || "false") === "true",
            what_you_do: String(qs("#offer_what")?.value || "").trim() || null,
            what_they_get: String(qs("#offer_features")?.value || "").trim() || null,
            who_its_for: String(qs("#offer_audience")?.value || "").trim() || null,
            how_it_works: String(qs("#offer_process")?.value || "").trim() || null,
            main_result: String(qs("#main_result")?.value || "").trim() || null,
            best_fit_leads: String(qs("#best_fit_leads")?.value || "").trim() || null,
            not_a_fit: String(qs("#not_a_fit")?.value || "").trim() || null,
            common_objections: String(qs("#common_objections")?.value || "").trim() || null,
            closing_triggers: String(qs("#closing_triggers")?.value || "").trim() || null,
            urgency_reason: String(qs("#urgency_reason")?.value || "").trim() || null,
            trust_builders: String(qs("#trust_builders")?.value || "").trim() || null,
            faq: String(qs("#faq")?.value || "").trim() || null,
            offer_price: String(qs("#offer_price")?.value || "").trim() || null,
            niche: String(qs("#niche")?.value || "generic"),
            tone: String(qs("#tone")?.value || "").trim() || null,
            style: String(qs("#style")?.value || "").trim() || null,
            vocabulary: String(qs("#vocabulary")?.value || "").trim() || null,
            system_prompt: String(qs("#system_prompt")?.value || "").trim() || null,
            example_messages: exParsed.value || null,
          }),
        });

        showOk("Settings saved ✓");
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        const b = qs("#saveBtn");
        if (b) { b.disabled = false; b.style.opacity = "1"; b.textContent = "Save settings"; }
      }
    });
  }

  // ── Expand/collapse optional section ─────────────────────────────────────

  function wireExpandToggle() {
    const toggle = qs("#expandToggle");
    const body = qs("#expandBody");
    const chevron = qs("#expandChevron");
    if (!toggle || !body || !chevron) return;

    toggle.addEventListener("click", () => {
      const isOpen = body.classList.contains("open");
      body.classList.toggle("open", !isOpen);
      chevron.classList.toggle("open", !isOpen);
    });
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  function wireLogout() {
    const btn = qs("#logoutBtn");
    if (!btn || btn.__wired) return;
    btn.__wired = true;
    btn.addEventListener("click", () => {
      clearToken();
      window.location.href = "/coach/login.html";
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", async () => {
    if (!getToken()) {
      window.location.href = "/coach/login.html";
      return;
    }

    wireLogout();
    wireInstagramConnectButton();
    wireSaveButton();
    wireGeneratePromptButton();
    wireExpandToggle();
    wireBadges(); // wire change listeners before loadConfig populates values

    await Promise.allSettled([
      loadConfig(),
      loadInstagramConnectionStatus(),
      loadPromptUsageStatus(),
    ]);

    // Sync badge display after config values are loaded into selects
    wireBadges();

    // Auto-expand optional section if any optional fields are already filled
    const optionalIds = ["offer_what","offer_features","offer_audience","offer_process","main_result","best_fit_leads","not_a_fit","common_objections","closing_triggers","urgency_reason","trust_builders","faq"];
    const hasOptional = optionalIds.some((id) => String(qs(`#${id}`)?.value || "").trim());
    if (hasOptional) {
      const body = qs("#expandBody");
      const chevron = qs("#expandChevron");
      if (body) body.classList.add("open");
      if (chevron) chevron.classList.add("open");
    }
  });
})();
