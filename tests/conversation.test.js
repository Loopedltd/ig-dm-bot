/**
 * Conversation logic tests — runnable with:
 *   node tests/conversation.test.js
 *
 * Uses only Node built-ins (assert). No external test framework needed.
 * Run this before every push — see README for details.
 */

import assert from "node:assert/strict";
import {
  PITCH_DISMISSAL_MESSAGE,
  SYSTEM_PROMPT_RULES,
  isCasualGreeting,
  detectDirectProductRequest,
  detectPersonalQuestion,
  detectUnknownProductMention,
  detectSalesPitch,
  computeConversationGap,
  shouldUseKeywordAutoDm,
} from "../lib/conversationLogic.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

console.log("\nConversation Logic Tests\n");

// ---------------------------------------------------------------------------
// 1. Casual greeting — first message must not get qualifying/booking language
//    The system prompt GREETING RULE prevents this. We verify:
//    a) isCasualGreeting correctly identifies the opener
//    b) The rule text is defined and non-trivial (guards against accidental deletion)
// ---------------------------------------------------------------------------
test("1. Casual greeting — 'hey' is detected as a casual greeting", () => {
  assert.ok(isCasualGreeting("hey"), "'hey' should be a casual greeting");
  assert.ok(isCasualGreeting("Hi!"), "'Hi!' should be a casual greeting");
  assert.ok(isCasualGreeting("hello"), "'hello' should be a casual greeting");
  assert.ok(isCasualGreeting("how are you"), "'how are you' should be a casual greeting");
  assert.ok(
    !isCasualGreeting("hey I want to know about your programme"),
    "message with intent beyond 6 words should NOT be a casual greeting"
  );
  assert.ok(
    !isCasualGreeting("what results do your clients get?"),
    "product question should NOT be a casual greeting"
  );
  // Verify the GREETING RULE exists in the system prompt (guards against accidental removal)
  assert.ok(
    SYSTEM_PROMPT_RULES.greetingRule.length > 10,
    "GREETING RULE text must be non-empty — rule may have been removed from the system prompt"
  );
});

// ---------------------------------------------------------------------------
// 2. Direct product request — response must contain a link immediately
//    detectDirectProductRequest drives the "send_product_link_now" turn strategy.
// ---------------------------------------------------------------------------
test("2. Direct product request — 'send me your programme' triggers immediate link send", () => {
  const products = [{ name: "12-Week Coaching", url: "https://example.com/coaching" }];

  assert.ok(
    detectDirectProductRequest("send me your programme", products),
    "'send me your programme' should trigger a direct product request"
  );
  assert.ok(
    detectDirectProductRequest("can I get the link?", products),
    "'can I get the link?' should trigger a direct product request"
  );
  assert.ok(
    detectDirectProductRequest("give me the link please", products),
    "'give me the link please' should trigger a direct product request"
  );
  assert.ok(
    !detectDirectProductRequest("hey how are you", products),
    "casual greeting should NOT trigger a direct product request"
  );
  assert.ok(
    !detectDirectProductRequest("what do you do?", products),
    "general question should NOT trigger a direct product request"
  );
  // Verify the DIRECT PRODUCT REQUEST RULE is present in the system prompt
  assert.ok(
    SYSTEM_PROMPT_RULES.directProductRequestRule.length > 10,
    "DIRECT PRODUCT REQUEST RULE text must be non-empty"
  );
});

// ---------------------------------------------------------------------------
// 3. Gap detection — long_gap must produce a warm re-opener
//    computeConversationGap drives the conversation_gap field passed to the AI.
// ---------------------------------------------------------------------------
test("3. Gap detection — 25h gap produces 'long_gap', <6h produces 'same_session'", () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  assert.strictEqual(
    computeConversationGap(hoursAgo(25), 3),
    "long_gap",
    "25-hour gap should produce 'long_gap'"
  );
  assert.strictEqual(
    computeConversationGap(hoursAgo(10), 3),
    "medium_gap",
    "10-hour gap should produce 'medium_gap'"
  );
  assert.strictEqual(
    computeConversationGap(hoursAgo(2), 3),
    "same_session",
    "2-hour gap should produce 'same_session'"
  );
  assert.strictEqual(
    computeConversationGap(null, 0),
    "first_message",
    "null prevLastInboundAt with no history should produce 'first_message'"
  );
  assert.strictEqual(
    computeConversationGap(hoursAgo(25), 0),
    "first_message",
    "timestamp but zero history should still produce 'first_message'"
  );
  // Verify the GAP AWARENESS RULE is present in the system prompt
  assert.ok(
    SYSTEM_PROMPT_RULES.gapAwarenessLongGap.includes("long_gap"),
    "GAP AWARENESS RULE must reference 'long_gap'"
  );
});

// ---------------------------------------------------------------------------
// 4. No repeated questions — the system prompt must carry the no-repeat rule
//    The CONVERSATION HISTORY RULE and the core no-repeat-questions instruction
//    are exported as constants so their presence is verifiable without calling
//    OpenAI. Changing them in index.js without updating the constant here
//    will cause this test to fail and prompt a review.
// ---------------------------------------------------------------------------
test("4. System prompt carries the no-repeated-questions rule", () => {
  assert.ok(
    SYSTEM_PROMPT_RULES.noRepeatQuestions.includes("NEVER ask the same question twice"),
    "System prompt must contain 'NEVER ask the same question twice in a conversation'"
  );
  assert.ok(
    SYSTEM_PROMPT_RULES.conversationHistoryRule.includes("already been answered"),
    "CONVERSATION HISTORY RULE must reference checking for questions already answered"
  );
});

// ---------------------------------------------------------------------------
// 5. Sales pitch deflection — pitch language must result in the dismissal message
// ---------------------------------------------------------------------------
test("5. Sales pitch deflection — pitch language detected and correct dismissal message used", () => {
  assert.ok(
    detectSalesPitch("i can help you get more clients"),
    "canonical pitch opener must be detected"
  );
  assert.ok(
    detectSalesPitch("I help coaches like you grow their business"),
    "pattern-matched pitch must be detected"
  );
  assert.ok(
    detectSalesPitch("we specialize in helping coaches like you"),
    "agency pitch must be detected"
  );
  assert.ok(
    !detectSalesPitch("how much is your coaching?"),
    "genuine lead question must NOT be detected as a pitch"
  );
  assert.ok(
    !detectSalesPitch("hey, I'm interested in working on my fitness"),
    "lead expressing interest must NOT be flagged as a pitch"
  );
  // The message actually sent to the lead must match the dismissal constant
  assert.strictEqual(
    PITCH_DISMISSAL_MESSAGE,
    "Thanks for reaching out - we're not looking for that right now.",
    "PITCH_DISMISSAL_MESSAGE must match the exact message sent in index.js"
  );
});

// ---------------------------------------------------------------------------
// 6. Product matching — message mentioning a saved product name triggers detection
//    detectDirectProductRequest catches named-product mentions; detectUnknownProductMention
//    returns null (no false-positive flag) when the product IS in the list.
// ---------------------------------------------------------------------------
test("6. Product matching — named product in message triggers detection; known product not flagged as unknown", () => {
  const products = [
    { name: "12-Week Shred", url: "https://example.com/shred" },
    { name: "Mindset Reset", url: "https://example.com/mindset" },
  ];

  assert.ok(
    detectDirectProductRequest("tell me about the 12-Week Shred", products),
    "named product mention should trigger a direct product request"
  );
  assert.ok(
    detectDirectProductRequest("can I get the Mindset Reset?", products),
    "second named product should also trigger detection"
  );
  assert.strictEqual(
    detectUnknownProductMention("tell me about the 12-Week Shred", products),
    null,
    "a known product must NOT be flagged as an unknown product mention"
  );
  assert.notStrictEqual(
    detectUnknownProductMention("tell me about your secret programme", products),
    null,
    "an unknown product noun must be detected and return a non-null value"
  );
  // Verify the proactive product rule is present in system prompt
  assert.ok(
    SYSTEM_PROMPT_RULES.proactiveProductRule.includes("match by topic"),
    "PROACTIVE PRODUCT INTRODUCTION RULE must instruct semantic matching by topic"
  );
});

// ---------------------------------------------------------------------------
// 7. Personal question — detectPersonalQuestion returns true → coach flagged
//    In index.js the AI is instructed to set should_pause_for_coach: true for
//    personal questions. This test verifies the detection function is correct
//    and the system prompt rule is present.
// ---------------------------------------------------------------------------
test("7. Personal question detection — triggers manual_override via coach flag", () => {
  assert.ok(
    detectPersonalQuestion("where do you live?"),
    "location question must be detected as personal"
  );
  assert.ok(
    detectPersonalQuestion("are you married?"),
    "relationship question must be detected as personal"
  );
  assert.ok(
    detectPersonalQuestion("how old are you"),
    "age question must be detected as personal"
  );
  assert.ok(
    !detectPersonalQuestion("how much is your coaching?"),
    "pricing question must NOT be detected as personal"
  );
  assert.ok(
    !detectPersonalQuestion("what results do your clients get?"),
    "results question must NOT be detected as personal"
  );
  assert.ok(
    !detectPersonalQuestion("what does the programme include?"),
    "programme question must NOT be detected as personal"
  );
  // Verify the PERSONAL QUESTION RULE instructs the AI to pause for coach
  assert.ok(
    SYSTEM_PROMPT_RULES.personalQuestionRule.includes("should_pause_for_coach"),
    "PERSONAL QUESTION RULE must instruct the AI to set should_pause_for_coach: true"
  );
});

// ---------------------------------------------------------------------------
// Bonus: Keyword DM trigger — partial/contains match (not just exact match)
// ---------------------------------------------------------------------------
test("Bonus. Keyword DM — keyword anywhere in message triggers, not just exact-match", () => {
  const cfg = {
    keyword_auto_dm_enabled: true,
    keyword_trigger_text: "link",
    keyword_auto_dm_text: "here you go!",
  };

  assert.ok(
    shouldUseKeywordAutoDm(cfg, "link"),
    "exact keyword match should trigger"
  );
  assert.ok(
    shouldUseKeywordAutoDm(cfg, "can you send me the link please"),
    "keyword embedded in message should trigger"
  );
  assert.ok(
    shouldUseKeywordAutoDm(cfg, "LINK"),
    "case-insensitive keyword match should trigger"
  );
  assert.ok(
    !shouldUseKeywordAutoDm({ ...cfg, keyword_auto_dm_enabled: false }, "link"),
    "disabled keyword DM must not trigger"
  );
  assert.ok(
    !shouldUseKeywordAutoDm(cfg, "hey how are you"),
    "message without keyword must not trigger"
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
