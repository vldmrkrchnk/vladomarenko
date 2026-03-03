# Bot Update Checklist

- [x] Check /task/result.json contents <!-- id: 0 -->
- [x] Update Bot to use latest OpenAI model (v5.2) <!-- id: 1 -->
- [x] Rearrange users config structure to match prompt requirements <!-- id: 2 -->
    - [x] Update `users.json` (consolidate relationships, rename triggers to taboos, ensure tone is top-level)
    - [x] Update interfaces in `src/bot.ts`
- [x] Reorganize/Improve Bot "Brain" (System Prompt) <!-- id: 3 -->
    - [x] Update `identity.txt` with the new Core Identity and Style Rules
    - [x] Implement `CHAT_SUMMARY` (rolling summary) logic
    - [x] Implement `INTENT` selection logic
    - [x] Update `getKrapralResponseFromOpenAI` to construct the new Prompt format
