# CLAUDE.md

Notes for anyone (human or agent) changing this repo.

## Commands

- `npm run check` runs typecheck, sanitizer, client, triage tests and the evals. It must pass before any commit. No API key and no network needed.
- `npx ts-node scripts/smoke.ts owner/repo` hits the public GitHub API without a token (60 requests/hour). Use it to measure, not in CI.

## Rules

- Issue text is untrusted. Anything from a title, body or label goes through `src/shared/untrustedInput.ts` before it reaches a prompt. Add a fixture that attacks the new field before adding the field.
- Do not tune thresholds (`STRONG_EVIDENCE`, `evals/thresholds.json`) to make a number look better. If a change moves a metric, record why in the README.
- A new eval gate needs a case that makes it fail. A gate that cannot fail is not a gate.
- `classifyWithModel` is not implemented yet. When it is, it must be scored against the same fixtures as the rule-based path, and the key comes from the environment only, never from the repo.
- Keep the README honest about what works and what does not.
