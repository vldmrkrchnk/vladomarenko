# Changelog

## 2026-04-21 — identity & behavior overhaul

Triggered by analysis of `ChatExport_2026-04-21/` (messages 2026-03-03 → 2026-04-21).

### Planned

**Bugs (from log analysis)**
- [ ] Fix `[REACT:🔥]` and `[REACT:🌟]` leaking as raw text when replying to empty-text messages (photos/stickers). Strip REACT/POLL tags; if nothing left, skip sending text.
- [ ] Strip `@Krapral:` self-prefix from bot output (3 instances observed).
- [ ] Strip Russian case endings from mentions (`@vinohradovом` → `@vinohradov`); enforce square-bracket mentions → `@handle`.

**Identity / behavior**
- [ ] Add `@Gadzo4ka` (ДимОн) to `users.json` with base profile — user will customize.
- [ ] Rework `users.json` — add `can_push_on` field per participant (what bot can genuinely roast about). Relax `avoid` — keep only real no-go zones, not blanket "агрессия".
- [ ] Add `<moods>` section to `identity.txt`: default (brotherly banter), confrontation/roast, philosophical/hangover, paranoid, pumped.
- [ ] Add `<roast_arsenal>` to `identity.txt` — ~50 insults/nicknames categorized by severity (light / medium / heavy).
- [ ] Add confrontation trigger rules to `identity.txt`: when user says "прожарь", "обзови", "включай роаст", "конфронтируй" → enter roast mode for that user for the next few turns.
- [ ] Remove `"люблю отряд"`-softness cap that's currently making the bot too timid; explicit instruction: bot DOES push back with real insults when prompted or when matched aggression.

**Housekeeping**
- [ ] Include `ChatExport_2026-04-21/` in repo (large — review `.dockerignore` to make sure it doesn't bloat the Docker image).

### Shipped

**Bugs (src/bot.ts)**
- [x] `[REACT:...]` / `[POLL:...]` tags now extracted BEFORE touching the placeholder message. If the model returns a tag-only response, the placeholder is deleted (with fallback to `...` if delete fails). Streaming edits also strip tags mid-stream so users never see raw `[REACT:🔥]` text. Added `stripActionTags()` helper.
- [x] `cleanBotPrefix()` regex for the Latin `@Krapral:` variant now uses `+` to strip repeated prefixes (matches the Cyrillic handling; was already working for single prefix, this is belt-and-braces).
- [x] Added explicit rule #14 in `identity.txt`: mentions must be exactly `@username`, no Russian case endings, no `[brackets]`. Also notes that `ДимОн = @Gadzo4ka` (not `@_Gadzo4ka`).
- [x] Added explicit rule #15 in `identity.txt`: never prefix own messages with `@Krapral:` / `Крапрал:` / `Капрал:`.

**Identity / behavior**
- [x] `@Gadzo4ka` (ДимОн) added to `users.json` with observable profile — short aggressive one-liners, mat, shitpost, provocations. Marked `_note_to_user` so user can swap in real nicknames/inside jokes.
- [x] Added `can_push_on` to every participant in `users.json` — concrete, observable roast targets (height, nicknames, habits already used in chat by the group). Nothing invented.
- [x] Relaxed `avoid` fields: blanket bans like "агрессия" and "давление" removed. What stays in `avoid` is only genuine no-go (real family, real health, actual trauma).
- [x] Added `group_dynamics` block in `users.json` that tells the bot the group really does confront each other and it should participate as a peer, not a moderator.
- [x] Added `display_aliases` to each participant so the bot can use nicknames the group already uses.
- [x] `identity.txt` rule #16 — 5 moods: БРАТСКОЕ (60%, default) / РОАСТ / ФИЛОСОФ_ПОХМЕЛЬНЫЙ / ПАРАНОИК / БОДРЫЙ_ПЬЯНЫЙ with % distribution and when to switch.
- [x] `identity.txt` rule #17 — roast triggers: auto (when someone's attacked, when bot itself is attacked) + explicit ("прожарь @X", "обзови @X", "без фильтра", "крапрал обоссы @X" etc). Rules lock roast ammo to `can_push_on` and keep `avoid` untouchable.
- [x] `identity.txt` rule #18 — roast arsenal with 4 tiers (лёгкие / средние / жёсткие / военно-медицинские) and personal nicknames.
- [x] `identity.txt` rule #19 — explicit anti-timid instruction: confrontation is normal, giving back is normal, the softness cap is removed for items in `can_push_on`.

**Housekeeping**
- [x] `ChatExport_2026-04-21/` copied into repo (2MB) for future analysis. `.dockerignore` already excludes `ChatExport_*`.

### Deferred / needs user customization

- [ ] `users.json` — user to expand `can_push_on` with real/inside-joke weak points that only the group knows (relationships, incidents, specific habits). Current entries are conservative based on observable chat patterns only.
- [ ] `users.json` — user to customize `@Gadzo4ka` profile (`_note_to_user` marker in the file). Add real nicknames, correct role.
- [ ] Validate in-chat: after deploy, watch new responses for ~3 days. If bot still too soft → add more aggressive language/more `can_push_on` material. If too harsh → tighten `avoid`.
- [ ] Consider a `/mode` command or explicit state for roast mode if context-based auto-triggers aren't reliable enough (not implemented today — starting with the text-trigger approach in identity.txt).
- [ ] Re-export chat in ~2 weeks, re-run the analysis script, see what catchphrase distribution and mood distribution actually look like post-change.

### How to verify after deploy

1. `fly logs` — should show no crashes, bot boots cleanly with updated identity/users
2. In Telegram: send `прожарь @<someone>` → bot should enter roast mode for 2-3 turns
3. Spot-check output: bot should no longer prefix its messages with `@Krapral:`, mentions should stay `@username` without case endings, no more `[REACT:🔥]` leaks as text
4. Daily skim of `fly logs` for a week — watch for any `error_code: 401/409` or strange behaviour
