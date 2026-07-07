# Looped — Instagram DM Automation

## Running the server

```bash
node index.js
```

## Tests

Run the conversation logic test suite before every push:

```bash
npm test
# or directly:
node tests/conversation.test.js
```

The tests cover:

1. Casual greeting detection — `hey` must not trigger qualifying/booking language
2. Direct product request detection — `send me your programme` must trigger an immediate link
3. Conversation gap detection — 24 h+ gap must be classified as `long_gap` (warm re-opener)
4. No-repeated-questions rule — verified present in system prompt
5. Sales pitch deflection — pitch language detected and correct dismissal message used
6. Product matching — named product in message triggers detection; known products not false-flagged
7. Personal question detection — triggers `should_pause_for_coach` → `manual_override`

Tests use only Node built-ins (`assert`). No install needed beyond the existing dependencies.

**Run these before every push.** A non-zero exit code means at least one test failed — do not push until all tests pass.

To add a pre-push git hook that enforces this automatically:

```bash
echo '#!/bin/sh\nnpm test || exit 1' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```
