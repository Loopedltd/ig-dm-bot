/**
 * Pure conversation logic — no server or database dependencies.
 * Imported by index.js and by the test suite.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The exact message sent to a lead who is detected as pitching to the coach. */
export const PITCH_DISMISSAL_MESSAGE =
  "Thanks for reaching out - we're not looking for that right now.";

/**
 * Key phrases that must appear in the system prompt.
 * Tests assert these are non-empty — if a rule is accidentally removed from
 * index.js the constant must be updated here, making the omission visible.
 */
export const SYSTEM_PROMPT_RULES = {
  greetingRule:
    "respond warmly and naturally: \"hey! how can I help?\"",
  noRepeatQuestions:
    "NEVER ask the same question twice in a conversation",
  conversationHistoryRule:
    "never ask a question that has already been answered earlier in this conversation",
  gapAwarenessLongGap:
    "\"long_gap\": 24 hours or more since their last message",
  directProductRequestRule:
    "send the relevant product link or booking link immediately",
  personalQuestionRule:
    "set should_pause_for_coach: true in your response",
  proactiveProductRule:
    "match by topic, theme, and description",
};

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

export function normaliseTriggerText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}

export function parseKeywordFromPhrase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // If coach types: dm me "START"
  const quoted = raw.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return normaliseTriggerText(quoted[1]);

  // fallback: use whole field
  return normaliseTriggerText(raw);
}

// ---------------------------------------------------------------------------
// Conversation gap detection
// ---------------------------------------------------------------------------

/**
 * Returns the gap bucket between the previous inbound message and now.
 *
 * @param {string|null} prevLastInboundAt  ISO timestamp of last inbound message before this one
 * @param {number}      historyLength      Number of history messages (0 = first ever message)
 * @returns {"first_message"|"same_session"|"medium_gap"|"long_gap"}
 */
export function computeConversationGap(prevLastInboundAt, historyLength) {
  if (!prevLastInboundAt || historyLength === 0) return "first_message";
  const gapMs = Date.now() - new Date(prevLastInboundAt).getTime();
  if (gapMs >= 86_400_000) return "long_gap";   // 24 h+
  if (gapMs >= 21_600_000) return "medium_gap"; // 6–24 h
  return "same_session";                         // < 6 h
}

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

/**
 * Returns true when the lead's first message is a casual social opener
 * with no detectable intent (≤ 6 words, matches known greeting patterns).
 */
export function isCasualGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  if (t.split(/\s+/).length > 6) return false;
  return /^(hey|hi|hello|hiya|heya|yo|sup|wassup|what'?s up|hows it going|how are you|good morning|good afternoon|good evening|morning|afternoon|evening|alright|alright\?|you good|hope you'?re? well)[\s!?.]*$/.test(t);
}

/**
 * Returns true when the lead is explicitly asking to receive a product link
 * or named product right now — the bot should send the link immediately.
 */
export function detectDirectProductRequest(text, products) {
  if (!text) return false;
  const t = text.toLowerCase();
  const genericLinkRequest = /\b(send me|can i (get|have|see)|give me|share|drop|dm me|what'?s the link|get (the|your) link|link (please|pls|me)?|your (programme|program|product|plan|course|guide|pdf|freebie|resource))\b/.test(t);
  if (genericLinkRequest) return true;
  if (Array.isArray(products) && products.length > 0) {
    return products.some((p) => {
      const name = String(p.name || "").toLowerCase();
      return name.length > 2 && t.includes(name);
    });
  }
  return false;
}

/**
 * Returns true when the lead asks about personal details of the coach
 * (location, appearance, personal life) that cannot be answered from config.
 * The bot must not guess — should flag for coach input instead.
 */
export function detectPersonalQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /\b(where (are|do) you (live|based|from|stay)|where('?s| is) your (house|home|flat|apartment|gym|studio|office)|what (city|town|country|area) (are you|do you live)|your hair|your makeup|your nails|your skin|your routine|your diet outside|your personal|do you have (kids|children|a partner|a boyfriend|a girlfriend|a husband|a wife)|are you (married|single|in a relationship)|how old are you|your age|your height|your weight outside coaching|your personal life|where do you get|where did you get|who does your|who cut your|your tattoo|your piercing)\b/.test(t);
}

/**
 * Returns the matched noun phrase if the lead references a specific product
 * by a product-like noun that is NOT in the saved products list, or null otherwise.
 */
export function detectUnknownProductMention(text, products) {
  if (!text) return null;
  const t = text.toLowerCase();
  const productLikeNouns = [
    "programme", "program", "plan", "course", "guide", "pdf", "ebook",
    "product", "supplement", "kit", "pack", "bundle", "membership",
    "subscription", "challenge", "bootcamp", "workshop", "masterclass",
    "coaching", "service",
  ];
  for (const noun of productLikeNouns) {
    if (t.includes(noun)) {
      const savedNames = (products || [])
        .map((p) => String(p.name || "").toLowerCase())
        .filter(Boolean);
      const matchesSaved = savedNames.some((name) => t.includes(name));
      if (!matchesSaved) {
        const match = new RegExp(`(?:your|the|a|that)\\s+(?:\\w+\\s+)?${noun}`).exec(t);
        return match ? match[0] : noun;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sales pitch detection
// ---------------------------------------------------------------------------

/**
 * Returns true when a message is clearly someone pitching TO the coach,
 * not a lead buying from the coach.
 */
export function detectSalesPitch(text) {
  const t = String(text || "").toLowerCase();

  const pitchPhrases = [
    "i can help you get more clients",
    "i can help you grow your business",
    "i can help grow your",
    "i help coaches like you",
    "i help businesses like yours",
    "i help people like you",
    "we help coaches like you",
    "we help businesses like yours",
    "i'm reaching out because i",
    "i wanted to reach out to you",
    "i noticed your profile and",
    "i came across your profile and",
    "i've been following your content and",
    "i saw your profile and",
    "we specialize in helping coaches",
    "we specialise in helping coaches",
    "we specialize in helping businesses",
    "we specialise in helping businesses",
    "lead generation for coaches",
    "leads for coaches",
    "i can run your ads",
    "run ads for your business",
    "manage your social media",
    "social media management for",
    "seo for your business",
    "seo for coaches",
    "website for your business",
    "build your website",
    "i have a proposal for you",
    "i have an offer for you",
    "partnership opportunity for you",
    "collab opportunity for you",
    "collaboration opportunity for you",
    "book a call with me",
    "schedule a call with me",
    "dm me if you're interested",
    "dm me if interested",
    "reply if you're interested",
    "reply if interested",
    "let me know if you'd like to work together",
    "interested in working together",
    "our agency can",
    "our software can",
    "our platform can",
    "our tool can",
    "our service includes",
    "our services include",
    "our solution for",
  ];

  if (pitchPhrases.some((phrase) => t.includes(phrase))) return true;

  if (/\bi (help|assist|support|work with|grow|build|scale) (coaches|business owners|entrepreneurs|content creators) (like|such as) you\b/.test(t)) return true;

  if (
    /\bwe (offer|provide|do|handle|specialise in|specialize in)\b/.test(t) &&
    /\b(coaches|businesses|clients|leads|social media|ads|seo|content|websites|marketing)\b/.test(t)
  ) return true;

  return false;
}

/**
 * Returns true if a message (after a pitch dismissal) looks like a genuine
 * question about the coach's services — used to resume the bot.
 */
export function detectGenuineLeadQuestion(text) {
  const t = String(text || "").toLowerCase().trim();

  if (/\b(how much|what does it cost|what'?s the price|pricing|your price|price of)\b/.test(t)) return true;
  if (/\b(how do(es)? it work|what do you (do|offer|help with|include)|tell me more|more info|more details)\b/.test(t)) return true;
  if (/\bi'?m interested\b/.test(t)) return true;
  if (/\bim interested\b/.test(t)) return true;
  if (/\bi want (your|to (know|find out|learn|join|sign up|get started|book|buy|purchase))\b/.test(t)) return true;
  if (/\binterested in (your|this|the|what)\b/.test(t)) return true;
  if (/\b(i'?d (like|love|want) to|i want (in|this|that|it))\b/.test(t)) return true;
  if (/\b(sounds (good|great|interesting|amazing)|that sounds|this sounds)\b/.test(t)) return true;
  if (/\b(let'?s do it|count me in|sign me up|i'?m in)\b/.test(t)) return true;
  if (/\b(what('?s| is) (included|in it|in the (program|coaching|package)))\b/.test(t)) return true;
  if (/\b(book(ing)?|sign up|get started|start|join|enrol|enroll)\b/.test(t)) return true;
  if (/\b(can i (ask|know|get|book|join)|do you (offer|have|work with))\b/.test(t)) return true;
  if (/\b(coaching|program|package|course|service|session|call with you|work with you)\b/.test(t)) return true;
  if (/\b(results|transformation|testimonials|success stories)\b/.test(t)) return true;
  if (/\b(what do (i|you)|how does|when (can|do|would)|where (do|can|should))\b/.test(t)) return true;
  if (/\bsorry\b/.test(t)) return true;

  if (t.length > 0 && !detectSalesPitch(text)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Webhook trigger helpers
// ---------------------------------------------------------------------------

export function isStoryReplyTrigger(messaging) {
  const referralSource = String(
    messaging?.referral?.source ||
    messaging?.postback?.referral?.source ||
    ""
  ).toLowerCase();

  return !!(
    messaging?.message?.reply_to?.story ||
    messaging?.message?.reply_to?.story_id ||
    messaging?.message?.is_story_reply === true ||
    referralSource === "story_mention" ||
    referralSource === "story"
  );
}

export function shouldUseStoryAutoDm(cfg, messaging) {
  return !!(
    cfg?.story_reply_auto_dm_enabled &&
    String(cfg?.story_reply_auto_dm_text || "").trim() &&
    isStoryReplyTrigger(messaging)
  );
}

export function isCommentReplyTrigger(messaging) {
  const referralSource = String(
    messaging?.referral?.source ||
    messaging?.postback?.referral?.source ||
    ""
  ).toLowerCase();

  const referralType = String(
    messaging?.referral?.type ||
    messaging?.postback?.referral?.type ||
    ""
  ).toLowerCase();

  const replyTo = messaging?.message?.reply_to || null;

  return !!(
    messaging?.message?.is_comment_reply === true ||
    replyTo?.comment_id ||
    referralSource === "comments" ||
    referralSource === "post" ||
    referralType === "comment_mention"
  );
}

export function shouldUseCommentAutoDm(cfg, messaging) {
  return !!(
    cfg?.comment_reply_auto_dm_enabled &&
    String(cfg?.comment_reply_auto_dm_text || "").trim() &&
    isCommentReplyTrigger(messaging)
  );
}

export function shouldUseKeywordAutoDm(cfg, text) {
  if (!cfg?.keyword_auto_dm_enabled) return false;

  const trigger = parseKeywordFromPhrase(cfg?.keyword_trigger_text);
  if (!trigger) return false;

  const incoming = normaliseTriggerText(text);
  if (!incoming) return false;

  // Allow the keyword to appear anywhere in the message (not just exact-match whole message)
  return incoming.includes(trigger);
}
