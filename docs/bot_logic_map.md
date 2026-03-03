# Bot Logic Map & Analysis

## 1. Core Architecture
The bot operates as a **stateful event loop** built on `Telegraf` (Telegram API) and `OpenAI`. It relies on local in-memory state (`history`, `activePolls`, `accumulatedMessages`) backed by simple JSON file persistence.

### Key Logic Loops
1.  **Incoming Message Stream** -> Debounce Buffer (4s) -> Processing Batch.
2.  **Poll Event Stream** -> State Update -> Conditional AI Trigger.
3.  **Background Tasks** -> Rolling Summarization (Every 10 msgs).

---

## 2. Text Message Flow (The "Brain")

### Logic
1.  **User sends text** (or sticker, forwarded message).
2.  **Debounce**: Bot waits `4000ms`. If more messages come, they are bundled (Batching).
3.  **Trigger Check** (in `processAccumulatedMessages`):
    *   **Direct Mention**: (`@krapral`, `капрал`, `крапрал`, `краб`, reply to bot) -> **Immediate Reply** (even during quiet hours).
    *   **Context Reply**: Did bot ask a question recently (<2 mins)? -> **Immediate Reply** (even during quiet hours).
    *   **Gatekeeper (The "Smart" Check)** (skipped during quiet hours 2-7am):
        *   If neither above, call `checkContextForReply` (`gpt-4o-mini`).
        *   Prompt: "Is it conversationally good to speak?"
        *   Result: `YES` -> **Reply**.
        *   Result: `NO` -> **Random Chance (2%)** -> **Reply**.

### API Frequency & Cost
*   **Gatekeeper**: 1 call per *batch* of untagged messages.
    *   *Model*: `gpt-4o-mini` (lightweight, fast).
*   **Response Generation**: 1 call per *decided reply*.
    *   *Model*: `gpt-5.2`.
*   **Summarizer**: 1 call per 10 history items.
    *   *Model*: `gpt-4o`.

### Post-Processing
*   **Prefix stripping**: Removes `@Krapral :`, `Krapral:`, `Bot:`, `AI:` prefixes (and recursive variants).
*   **Refusal catching**: Detects generic AI refusals ("Извините, я не могу помочь...") and replaces them with in-character deflections.
*   **Anti-repetition**: System prompt includes last 10 bot messages to prevent phrase repetition.

---

## 3. Media Flow (The "Eyes & Ears")

### Logic
1.  **User sends Audio/Voice/Video**.
2.  **Download**: Stream file to temp storage.
3.  **Audio Processing**:
    *   Extract audio track (ffmpeg).
    *   **Transcribe**: `openai.audio.transcriptions.create` (Whisper-1).
    *   Result text is treated as a User Text Message (goes to Debounce/Batch).
4.  **Video Processing**:
    *   Extract 3 frames via `ffmpeg` (10%, 50%, 90% marks).
    *   Convert to Base64.
    *   Frames are passed to `getKrapralResponse` as vision content parts (detail: low).
5.  **Sticker Handling**: Emoji extracted and sent as `[STICKER: emoji]` text.
6.  **Forwarded Messages**: Source attribution added as `[FORWARDED from source]` prefix.

### API Frequency
*   **Whisper**: 1 call per audio/video message.
*   **Vision**: Included in main response call when video frames are present.

---

## 4. Poll Flow (The "Observer")

### Logic
1.  **Creation**: `message` handler detects poll. Saves `chatId` + `PollData`.
2.  **Voting**: `poll` handler updates counts.
3.  **Voter ID**: `poll_answer` handler tracks *who* voted.
4.  **AI Trigger Check**:
    *   Votes >= 3?
    *   AI Commented yet? (Boolean lock).
    *   Poll Age: 10s < age < 2h.
5.  **Execution**:
    *   If all true -> Call `gpt-5.2` with JSON schema.
    *   Action: `SILENT` or `TEASE`.
    *   Send message.
    *   Mark `aiCommented = true` (One-time only).

### API Frequency
*   **Poll Analysis**: 1 call per Poll (once threshold passed).
    *   *Efficiency*: High. Good design.

---

## 5. Model Usage Summary

| Function | Model | Frequency |
| :--- | :--- | :--- |
| **Main Response** | `grok-4-1-fast-non-reasoning` (primary) → `gpt-5.2` (fallback) | Per reply |
| **Context Gatekeeper** | `gpt-4o-mini` | Per untagged message batch |
| **Poll Analysis** | `grok-4-1-fast-non-reasoning` (primary) → `gpt-5.2` (fallback) | Once per poll (3+ votes) |
| **Chat Summary** | `gpt-4o` | Every 10 messages |
| **Audio Transcription** | `whisper-1` | Per audio/video message |

## 6. Memory Management
*   **History**: Last 50 messages persisted to `last_50.json` after each message.
*   **processedMessageIds**: `Set<number>` with hourly pruning (max 5000 entries) to prevent memory leaks.
*   **activePolls**: `Map` cleared when polls close or age out.

## 7. Remaining Optimization Opportunities

| Feature | Current Implementation | Optimization Opportunity | Impact |
| :--- | :--- | :--- | :--- |
| **History** | `last_50.json` (File write every msg) | **Redis** or **In-Memory only** | Disk I/O reduction (Low prio) |
| **Photo handling** | Caption only, no image analysis | Feed photos to vision model | Feature enhancement |
