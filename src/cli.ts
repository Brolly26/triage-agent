/**
 * Triage one issue from the terminal.
 *
 *   npm run triage -- owner/repo#123            rules, no key needed
 *   npm run triage -- owner/repo#123 --model    Claude (ANTHROPIC_API_KEY)
 *   npm run triage -- owner/repo#123 --json     machine-readable
 *
 * GITHUB_TOKEN is optional and only raises the GitHub rate limit.
 */

import { fetchIssue, GitHubError } from './github/client';
import { classifyWithRules, classifyWithModel } from './triage/classify';
import { Issue, Triage } from './shared/types';

export interface Target { owner: string; repo: string; number: number }

export function parseTarget(spec: string | undefined): Target | null {
  const m = spec?.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export function format(issue: Issue, t: Triage): string {
  const lines = [
    `${issue.repo}#${issue.number}  ${issue.title}`,
    '',
    `  category    ${t.category} (confidence ${t.confidence}, via ${t.path})`,
    `  priority    ${t.priority}`,
    `  facts       version=${t.extracted.version ?? '?'} platform=${t.extracted.platform ?? '?'} ` +
      `repro=${t.extracted.hasReproSteps ? 'yes' : 'no'} stack=${t.extracted.hasStackTrace ? 'yes' : 'no'}`,
    t.escalate
      ? `  decision    ESCALATE to a human: ${t.escalationReason}. No reply drafted.`
      : '  decision    handled automatically',
  ];
  if (t.draftReply) lines.push('', '  draft reply:', '    ' + t.draftReply);
  return lines.join('\n');
}

async function main(argv: string[]) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const target = parseTarget(args[0]);
  if (!target) {
    console.error('usage: triage owner/repo#123 [--model] [--json]');
    return 2;
  }
  try {
    const issue = await fetchIssue({ ...target, token: process.env.GITHUB_TOKEN });
    const t = flags.has('--model') ? await classifyWithModel(issue) : classifyWithRules(issue);
    console.log(flags.has('--json') ? JSON.stringify({ issue: { repo: issue.repo, number: issue.number, title: issue.title }, triage: t }, null, 2) : format(issue, t));
    return 0;
  } catch (err) {
    console.error(err instanceof GitHubError ? `GitHub: ${err.message}` : err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
