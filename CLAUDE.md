# CLAUDE.md

Notes for anyone (human or agent) changing this repo.

## Commands

- `npm run check` runs typecheck, sanitizer, client, triage tests and the evals. It must pass before any commit. No API key and no network needed.
- `npm run triage -- owner/repo#123` triages one real issue (add `--model` for Claude).
- `npx ts-node scripts/smoke.ts owner/repo` hits the public GitHub API without a token (60 requests/hour). Use it to measure, not in CI.

## Rules

- Issue text is untrusted. Anything from a title, body or label goes through `src/shared/untrustedInput.ts` before it reaches a prompt. Add a fixture that attacks the new field before adding the field.
- Do not tune thresholds (`STRONG_EVIDENCE`, `evals/thresholds.json`) to make a number look better. If a change moves a metric, record why in the README.
- A new eval gate needs a case that makes it fail. A gate that cannot fail is not a gate.
- `classifyWithModel` only decides category and confidence. Guards, priority and drafted replies stay deterministic; keep it that way. The key comes from `.env` only, never from the repo. `npm run eval:llm` costs money and is not part of `check`.
- Keep the README honest about what works and what does not.
