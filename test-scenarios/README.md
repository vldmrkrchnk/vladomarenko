# Test Scenarios for Krapral Bot

Each JSON file simulates a chat history + incoming message.
Use these to verify bot behavior after fixes.

## How to use
Feed the `history` array as message context, then send `incoming` as the new message.
Check `expected_behavior` to verify the response is correct.

## Scenarios
1. `01-single-direct-ping.json` — single user pings Krapral directly
2. `02-wrong-username-fix.json` — Vovan writes, bot must address Vovan not Kapron
3. `03-self-prefix.json` — bot should NOT prefix with @Krapral:
4. `04-multi-message-catchup.json` — 5 messages while bot was silent, should only reply to latest
5. `05-emotional-outburst.json` — short emotional message, bot should stay silent
6. `06-new-soldier.json` — unknown user appears, bot should welcome
7. `07-military-tech-catchphrase.json` — verify the new "[техника] мне в [жопу]" style appears
