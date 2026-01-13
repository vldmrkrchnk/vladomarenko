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
1.  **User sends text**.
2.  **Debounce**: Bot waits `4000ms`. If more messages come, they are bundled (Batching).
3.  **Trigger Check** (in `processAccumulatedMessages`):
    *   **Direct Mention**: (`@krapral`, reply to bot) -> **Immediate Reply**.
    *   **Context Reply**: Did bot ask a question recently (<2 mins)? -> **Immediate Reply**.
    *   **Gatekeeper (The "Smart" Check)**:
        *   If neither above, call `checkContextForReply` (GPT-5.2).
        *   Prompt: "Is it conversationally good to speak?"
        *   Result: `YES` -> **Reply**.
        *   Result: `NO` -> **Random Chance (2%)** -> **Reply**.

### API Frequency & Cost
*   **Gatekeeper**: 1 call per *batch* of untagged messages.
    *   *Current Model*: `gpt-5.2` (Expensive/High Latency).
    *   *Optimization*: High frequency.
*   **Response Generation**: 1 call per *decided reply*.
    *   *Current Model*: `gpt-5.2`.
*   **Summarizer**: 1 call per 10 history items.
    *   *Current Model*: `gpt-4o`.

** optimization Opportunity**:
*   The **Gatekeeper** uses `gpt-5.2`. This is overkill for a simple "Yes/No" check. **Switching to `gpt-4o-mini`** would reduce cost/latency by 90% without losing quality.

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
    *   *current state*: Frames are passed to `enqueueMessage` but **NOT** added to the OpenAI payload in `getKrapralResponse`.

### API Frequency
*   **Whisper**: 1 call per audio/video message.
*   **Vision**: **0 calls** (Currently unimplemented in final step).

**CRITICAL OPTIMIZATION**:
*   **Wasted Compute**: We are downloading videos, running ffmpeg, and extracting frames, but **never showing them to the AI**.
*   *Fix*: Either disable video processing (save CPU/Bandwidth) OR update `getKrapralResponse` to accept image payloads so the bot can actually "see" the video. Currently, it's blind to the video content, only hearing the audio.

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

## 5. Optimization Summary Table

| Feature | Current Implementation | Optimization Opportunity | Impact |
| :--- | :--- | :--- | :--- |
| **Context Gatekeeper** | `gpt-5.2` on every batch | Downgrade to `gpt-4o-mini` | **$$$ Savings**, Faster "listening" |
| **Video Processing** | Extracts frames, ignores them | **Delete code** or **Enable Vision** | CPU/Bandwidth vs Feature fix |
| **Summarizer** | `gpt-4o` every 10 msgs | Keep as is (Reasonable) | Neutral |
| **Main Response** | `gpt-5.2` | Keep (Persona requires high IQ) | Neutral |
| **History** | `last_50.json` (File write every msg) | **Redis** or **In-Memory only** | Disk I/O reduction (Low prio) |

## 6. Recommended Next Steps
1.  **Fix Video Blindness**: Either feed the frames to GPT-5.2 or remove the heavy `ffmpeg` logic.
2.  **Optimize Gatekeeper**: Switch the "Should I reply?" check to a lightweight model.
3.  **Allow Options Flag**: Already optimized (RegEx check is effectively free).
