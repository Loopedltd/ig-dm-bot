import dotenv from "dotenv";
dotenv.config({ path: new URL("./.env", import.meta.url) });

import express from "express";
import { supabase } from "./supabaseClient.js";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

// Root test
app.get("/", (req, res) => {
  res.send("IG DM Bot is running");
});

// Webhook verification (Meta requirement)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// DB test: create or reuse a single test client
app.get("/db-test", async (req, res) => {
  try {
    const name = "Test Client";

    const { data: existing, error: findErr } = await supabase
      .from("clients")
      .select("*")
      .eq("name", name)
      .limit(1);

    if (findErr) return res.status(500).json(findErr);

    if (existing && existing.length > 0) {
      return res.json({ ok: true, reused: true, client: existing[0] });
    }

    const { data: client, error } = await supabase
      .from("clients")
      .insert([{ name, timezone: "Europe/London" }])
      .select()
      .single();

    if (error) return res.status(500).json(error);

    return res.json({ ok: true, reused: false, client });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Create a client (coach). If new, also create default bot config.
app.post("/clients/create", async (req, res) => {
  try {
    const { name, timezone } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const tz = timezone || "Europe/London";

    // 1) Reuse if exists (by name for now)
    const { data: existing, error: findErr } = await supabase
      .from("clients")
      .select("*")
      .eq("name", name)
      .limit(1);

    if (findErr) return res.status(500).json(findErr);

    if (existing && existing.length > 0) {
      return res.json({ ok: true, reused: true, client: existing[0] });
    }

    // 2) Create client
    const { data: client, error: createErr } = await supabase
      .from("clients")
      .insert([{ name, timezone: tz }])
      .select()
      .single();

    if (createErr) return res.status(500).json(createErr);

    // 3) Create default bot config for this client
    const defaultPrompt =
      "You are the coach's Instagram DM assistant. Be friendly, concise, and human. Ask one question at a time. If the user asks about price, explain simply and offer the link. If they seem serious, suggest booking a call.";

    const { error: cfgErr } = await supabase.from("client_configs").insert([
      {
        client_id: client.id,
        system_prompt: defaultPrompt,
        offer_type: "link",
        offer_url: null,
        booking_url: null,
        followup_rules: {
          enabled: true,
          max_followups: 2,
          delays_minutes: [120, 1440], // 2 hours, 24 hours
          quiet_hours: { start: 22, end: 8 },
        },
      },
    ]);

    if (cfgErr) return res.status(500).json(cfgErr);

    return res.json({ ok: true, reused: false, client });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Simulate inbound IG DM (stores lead + user message)
app.post("/simulate-dm", async (req, res) => {
  try {
    const { client_id, ig_psid, text, name } = req.body || {};
    if (!client_id || !ig_psid || !text) {
      return res
        .status(400)
        .json({ error: "client_id, ig_psid, and text are required" });
    }

    // 1) Upsert lead (one lead per client_id + ig_psid)
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .upsert(
        [
          {
            client_id,
            ig_psid,
            name: name || null,
            last_user_message_at: new Date().toISOString(),
            stage: "new",
          },
        ],
        { onConflict: "client_id,ig_psid" }
      )
      .select()
      .single();

    if (leadErr) return res.status(500).json(leadErr);

    // 2) Save message
    const { error: msgErr } = await supabase.from("messages").insert([
      {
        client_id,
        lead_id: lead.id,
        role: "user",
        content: text,
      },
    ]);

    if (msgErr) return res.status(500).json(msgErr);

    res.json({ ok: true, lead });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Simulate bot reply (loads config + latest user msg, saves bot msg, updates lead)
app.post("/simulate-reply", async (req, res) => {
  try {
    const { client_id, ig_psid } = req.body || {};
    if (!client_id || !ig_psid) {
      return res
        .status(400)
        .json({ error: "client_id and ig_psid are required" });
    }

    // 1) Load client config (bot personality / rules)
    const { data: cfg, error: cfgErr } = await supabase
      .from("client_configs")
      .select("*")
      .eq("client_id", client_id)
      .limit(1)
      .single();

    if (cfgErr) return res.status(500).json(cfgErr);

    // 2) Load lead
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", client_id)
      .eq("ig_psid", ig_psid)
      .limit(1)
      .single();

    if (leadErr) return res.status(500).json(leadErr);

    // 3) Load latest user message
    const { data: msgs, error: msgErr } = await supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (msgErr) return res.status(500).json(msgErr);

    const lastUserText = msgs?.[0]?.content || "";

    // 4) Simple reply generator (stable for now)
    let reply =
      "Thanks for the message! What’s your main goal right now (fat loss, muscle gain, or performance)?";

    const t = lastUserText.toLowerCase();
    if (t.includes("price") || t.includes("cost") || t.includes("how much")) {
      reply =
        "Totally — what’s your goal and your current situation? Once I know that I can tell you the best option and the price.";
    }

    // 5) Save bot message
    const { error: botMsgErr } = await supabase.from("messages").insert([
      {
        client_id,
        lead_id: lead.id,
        role: "bot",
        content: reply,
      },
    ]);

    if (botMsgErr) return res.status(500).json(botMsgErr);

    // 6) Update lead bot timestamp
    const { error: leadUpdateErr } = await supabase
      .from("leads")
      .update({ last_bot_message_at: new Date().toISOString() })
      .eq("id", lead.id);

    if (leadUpdateErr) return res.status(500).json(leadUpdateErr);

    res.json({ ok: true, reply, config_loaded: !!cfg });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Run follow-ups (manual trigger) — NOW includes safety rules
app.post("/run-followups", async (req, res) => {
  try {
    const now = new Date();

    // 1) Load all client configs with followups enabled
    const { data: configs, error: cfgErr } = await supabase
      .from("client_configs")
      .select("*")
      .eq("followup_rules->>enabled", "true");

    if (cfgErr) return res.status(500).json(cfgErr);

    let sent = 0;

    for (const cfg of configs) {
      const rules = cfg.followup_rules || {};
      const maxFollowups = rules.max_followups ?? 0;
      const delays = rules.delays_minutes ?? [];

      if (!maxFollowups || delays.length === 0) continue;

      // 2) Load leads for this client that are eligible
      const { data: leads, error: leadErr } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", cfg.client_id)
        .lt("followup_count", maxFollowups)
        .not("last_bot_message_at", "is", null);

      if (leadErr) return res.status(500).json(leadErr);

      for (const lead of leads) {
        const followupIndex = lead.followup_count || 0;
        const delayMinutes = delays[followupIndex];
        if (!delayMinutes) continue;

        const lastBot = new Date(lead.last_bot_message_at);
        const dueAt = new Date(lastBot.getTime() + delayMinutes * 60000);

        // Not due yet
        if (now < dueAt) continue;

        // SAFETY 1: don't follow up if the user replied after the last bot message
        if (lead.last_user_message_at && lead.last_bot_message_at) {
          const lastUser = new Date(lead.last_user_message_at);
          const lastBotMsg = new Date(lead.last_bot_message_at);
          if (lastUser > lastBotMsg) continue;
        }

        // SAFETY 2: respect quiet hours (Europe/London for now)
        const qh = rules.quiet_hours || { start: 22, end: 8 };
        const hourLondon = Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/London",
            hour: "2-digit",
            hour12: false,
          }).format(now)
        );

        const inQuietHours =
          qh.start < qh.end
            ? hourLondon >= qh.start && hourLondon < qh.end
            : hourLondon >= qh.start || hourLondon < qh.end;

        if (inQuietHours) continue;

        // 3) Simple follow-up copy (safe default)
        const followupText =
          "Just checking in — did you get a chance to see my last message? Happy to help if you have any questions.";

        // 4) Save follow-up message
        const { error: msgErr } = await supabase.from("messages").insert([
          {
            client_id: lead.client_id,
            lead_id: lead.id,
            role: "bot",
            content: followupText,
          },
        ]);

        if (msgErr) return res.status(500).json(msgErr);

        // 5) Update lead follow-up state
        const { error: updErr } = await supabase
          .from("leads")
          .update({
            followup_count: (lead.followup_count || 0) + 1,
            last_bot_message_at: new Date().toISOString(),
          })
          .eq("id", lead.id);

        if (updErr) return res.status(500).json(updErr);

        sent++;
      }
    }

    res.json({ ok: true, followups_sent: sent });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});