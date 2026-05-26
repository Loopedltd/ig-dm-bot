/**
 * One-off cleanup script for the learned_examples table.
 *
 * Usage:  node scripts/cleanup-learned-examples.js
 *
 * What it does:
 *   1. Fetches all rows from learned_examples via Supabase REST API.
 *   2. Flags rows where user_message or assistant_message contains
 *      inappropriate, offensive, or non-coaching-related content.
 *   3. Prints a summary, then deletes the bad rows.
 *   4. Confirms what was deleted.
 */

import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

// ── Same blocklist used in the main app ──────────────────────────────────────
const SAFETY_PATTERNS = [
  /\bfuck(?:ing?|er|ed|s)?\b/i,
  /\bshit(?:ty|ter|s)?\b/i,
  /\bassed?\b/i,
  /\bass\s*hole/i,
  /\bbitch(?:es|ing)?\b/i,
  /\bcunt\b/i,
  /\bcock\b/i,
  /\bdick\b/i,
  /\bpussy\b/i,
  /\bbastard\b/i,
  /\bbollocks\b/i,
  /\bwank(?:er|ers|ing)?\b/i,
  /\btwat\b/i,
  /\bpiss(?:ed|ing)?\b/i,
  /\bup\s+my\s+\w+/i,
  /\bsuck\s+my\b/i,
];

// Patterns that suggest content has nothing to do with coaching
const OFF_TOPIC_PATTERNS = [
  /\bpizza\b|\bburger\b|\btacos?\b|\bsushi\b/i,          // food unrelated to nutrition coaching
  /\bfortnite\b|\bminecraft\b|\bcall of duty\b|\bcod\b/i, // gaming
  /\bstocks?\b|\bcrypto\b|\bnft\b|\bbitcoin\b/i,          // finance (not money coaching)
  /\bweather\b|\bforecast\b/i,
  /\bhoroscope\b|\bastrology\b/i,
];

function isBadRow(row) {
  const u = String(row.user_message || "");
  const a = String(row.assistant_message || "");
  const combined = [u, a];

  for (const text of combined) {
    for (const re of SAFETY_PATTERNS) {
      if (re.test(text)) return { reason: "inappropriate_content", matched: re.source };
    }
    for (const re of OFF_TOPIC_PATTERNS) {
      if (re.test(text)) return { reason: "off_topic", matched: re.source };
    }
  }

  // Too short to be a useful coaching example
  if (a.trim().length < 4) return { reason: "assistant_too_short", matched: a };

  return null;
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function fetchAllRows() {
  // Supabase REST paginates at 1000 by default; use range header to get all
  let rows = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/learned_examples?select=id,client_id,user_message,assistant_message,source,approved,created_at&order=created_at.asc`,
      {
        headers: {
          ...headers,
          Range: `${from}-${from + PAGE - 1}`,
          "Range-Unit": "items",
        },
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Fetch failed (${res.status}): ${txt}`);
    }

    const page = await res.json();
    rows = rows.concat(page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  return rows;
}

async function deleteRows(ids) {
  if (!ids.length) return;
  const filter = ids.map((id) => `id.eq.${id}`).join(",");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/learned_examples?or=(${filter})`,
    { method: "DELETE", headers }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Delete failed (${res.status}): ${txt}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("🔍  Fetching all learned_examples rows…");
  const rows = await fetchAllRows();
  console.log(`   Found ${rows.length} total rows.\n`);

  const badRows = [];
  const cleanRows = [];

  for (const row of rows) {
    const result = isBadRow(row);
    if (result) {
      badRows.push({ row, ...result });
    } else {
      cleanRows.push(row);
    }
  }

  console.log(`✅  Clean rows:        ${cleanRows.length}`);
  console.log(`❌  Flagged for delete: ${badRows.length}\n`);

  if (!badRows.length) {
    console.log("Nothing to delete. Table is clean.");
    return;
  }

  console.log("Flagged rows:");
  for (const { row, reason, matched } of badRows) {
    console.log(`  [${row.id}]  reason=${reason}  match="${matched}"`);
    console.log(`    user:      ${String(row.user_message || "").slice(0, 120)}`);
    console.log(`    assistant: ${String(row.assistant_message || "").slice(0, 120)}`);
    console.log();
  }

  const ids = badRows.map(({ row }) => row.id);
  console.log(`🗑️   Deleting ${ids.length} rows…`);
  await deleteRows(ids);
  console.log(`✅  Deleted. ${cleanRows.length} rows remain.\n`);
})();
