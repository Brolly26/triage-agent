/** Domain types. Kept free of any GitHub-specific shape so the triage side
 *  never depends on the source the issues came from. */

/** An issue as the triage pipeline sees it, after normalisation. */
export interface Issue {
  /** Stable identity within one repository. */
  number: number;
  repo: string;
  title: string;
  /** May be empty: GitHub allows an issue with no body at all. */
  body: string;
  author: string;
  createdAt: string;
  labels: string[];
  commentCount: number;
  state: 'open' | 'closed';
  /** True when the collector had to truncate an oversized body. The
   *  classifier should know it is not seeing everything. */
  bodyTruncated: boolean;
}

export type Category = 'bug' | 'feature' | 'question' | 'duplicate';

export const CATEGORIES: Category[] = ['bug', 'feature', 'question', 'duplicate'];

export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/**
 * What the triage step produces for one issue.
 *
 * `confidence` drives the escalation decision, so it is part of the contract
 * rather than a debugging field: below the charter's threshold the issue goes
 * to a human regardless of how plausible the category looks.
 */
export interface Triage {
  issueNumber: number;
  category: Category;
  confidence: number;
  priority: Priority;
  /** Structured facts pulled out of the body, when present. */
  extracted: {
    version: string | null;
    platform: string | null;
    hasReproSteps: boolean;
    hasStackTrace: boolean;
  };
  /** Drafted reply, or null when the issue is escalated without one. */
  draftReply: string | null;
  escalate: boolean;
  /** Why it was escalated. Null when it was not. */
  escalationReason: EscalationReason | null;
  /** Which path produced this: the deterministic rules or the model. */
  path: 'rules' | 'llm';
}

export type EscalationReason =
  | 'low_confidence'
  | 'empty_body'
  | 'suspected_injection'
  | 'security_report'
  | 'model_unavailable';
