# Telegram Group AI Bot — Improvement Task

## Goal
Improve a Telegram group-chat AI bot across response logic, timing, multimodal handling, personality breadth, robustness, and liveliness.

The bot operates in a friends’ group chat and already supports:
- Voice → text transcription and understanding
- Keyword-based addressing
- Historical chat ingestion

This task expands quality, reliability, and personality without breaking the core identity.

---

## High-Level Strategy
- Work in **packages**, not isolated features
- Analyze **historical bot replies** to remove repetition and expand behavior
- Track progress with a **single checklist**
- Stop after each package for review

---

## Feasibility Overview

### Fully Achievable
- Response logic refactor
- Delayed replies when user is typing
- Handling multiple audio messages
- Proactive puzzles and emoji reactions
- Richer error messages with OpenAI/server feedback
- Model upgrade to a modern, less-censored generator
- Removing repeated jokes and phrases
- Improving roll-call / mention reliability
- Making the bot more human-like and alive
- Expanding identity while keeping the core persona

### Conditional / Model-Dependent
- Video understanding (location, activity, context)  
  Requires a **vision-capable model**.  
  Without it, use metadata + chat context heuristics.

---

## Work Packages

### Package A — Core Response Logic & Timing
**Objectives**
- Rebuild reply decision logic (direct address vs ambient chat)
- Add typing-aware delay (debounce replies if a user is actively sending messages)
- Improve handling of multiple audio messages sent in sequence
- Fix cases where the bot ignores all users during roll-calls

**Deliverables**
- Response decision tree
- Debounce and audio-queue logic
- Edge-case tests for mentions and roll-calls

---

### Package B — Multimodal Handling
**Objectives**
- Improve audio batching and summarization
- Support video understanding:
    - Vision model path (scene, activity, location cues)
    - Fallback path (captions, timestamps, surrounding chat context)

**Deliverables**
- Multimodal routing specification
- Vision / non-vision fallback logic

---

### Package C — Personality Expansion (Anti-Repetition)
**Objectives**
- Analyze historical bot replies
- Detect repeated jokes, phrases, and patterns
- Expand humor, tone, and reaction styles
- Preserve the existing identity while broadening expression

**Deliverables**
- Repetition analysis report
- Personality diversity matrix
- Updated persona definition
- Emoji/reaction usage rules

---

### Package D — Proactivity & Playfulness
**Objectives**
- Allow the bot to initiate:
    - Brain teasers
    - Small games or “head scratchers”
- Context-aware emoji reactions instead of text replies ( emotions mostly military thematic! )
- Respect quiet hours and chat cadence

**Deliverables**
- Proactivity ruleset
- Puzzle/game catalog with triggers

---

### Package E — Reliability & Observability
**Objectives**
- Improve error messages:
    - Include sanitized OpenAI/server feedback
    - Be informative but user-safe
- Add logging for failures and retries
- Upgrade to a modern, less-censored generation model (within policy)

**Deliverables**
- Error message templates
- Logging and observability checklist
- Model selection rationale

---

## Mandatory Analysis (Before Personality Changes)
The agent must ingest:
- Full chat history (/task/telegram/)
- Historical bot responses

And produce:
- Repetition heatmap
- Failure taxonomy
- Timing and latency observations
- Top missed-context scenarios

---

## Progress Tracking

Create `/task/checklist.md` with the following:

```md
- [ ] Package A started
- [ ] Package A completed
- [ ] Package B started
- [ ] Package B completed
- [ ] Package C started
- [ ] Package C completed
- [ ] Package D started
- [ ] Package D completed
- [ ] Package E started
- [ ] Package E completed
- [ ] Regression tests passed
- [ ] Persona approved

Execution Rules

- Work one package at a time
- Stop after each package for review and approval
- No personality expansion before history analysis
- No silent changes to core identity

Definition of Done

- Bot replies are context-aware, non-repetitive, and human-like
- Audio and video inputs are handled gracefully
- Errors are transparent and debuggable
- Personality feels broader without losing consistency
- Progress is fully traceable via checklist