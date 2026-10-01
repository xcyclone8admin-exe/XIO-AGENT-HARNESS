import type { ReviewerAssignment } from './contracts';
import { z } from 'zod';
import type { PreparedReviewBinding } from './prepared-run';

/**
 * Untrusted model-output shape for a review. Parsing validates syntax only; a host or Forge must
 * still validate claims and create evidence before storing a council decision or finding.
 */
export const ReviewResultDraft = z.strictObject({
  schemaVersion: z.literal(1),
  decision: z.enum(['findings', 'no-findings']),
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(z.strictObject({
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    title: z.string().trim().min(1).max(500),
    affectedRequirements: z.array(z.string().trim().min(1).max(128)).max(100),
    confidence: z.number().min(0).max(1),
    reproduction: z.string().trim().min(1).max(8000),
    remediation: z.string().trim().min(1).max(8000),
    revalidation: z.string().trim().min(1).max(8000),
    evidenceArtifactIds: z.array(z.uuid()).min(1).max(20),
  })).max(100),
}).superRefine((value, ctx) => {
  if (value.decision === 'findings' && value.findings.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'findings decision requires one or more findings' });
  }
  if (value.decision === 'no-findings' && value.findings.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'no-findings decision cannot contain findings' });
  }
  for (const [index, finding] of value.findings.entries()) {
    if (new Set(finding.evidenceArtifactIds).size !== finding.evidenceArtifactIds.length) {
      ctx.addIssue({ code: 'custom', path: ['findings', index, 'evidenceArtifactIds'], message: 'evidence references must be unique' });
    }
  }
});
export type ReviewResultDraft = z.infer<typeof ReviewResultDraft>;

/** Shape + binding-reference check. Does not certify the model's claims or create evidence. */
export function parseReviewResultDraft(value: unknown, binding: PreparedReviewBinding): ReviewResultDraft {
  const draft = ReviewResultDraft.parse(value);
  const allowedArtifacts = new Set(binding.artifacts.map((artifact) => artifact.id));
  for (const finding of draft.findings) {
    if (finding.evidenceArtifactIds.some((id) => !allowedArtifacts.has(id))) {
      throw new Error('REVIEW_RESULT_ARTIFACT_OUTSIDE_BINDING');
    }
  }
  return draft;
}

/** Enforces the reviewer/adversary isolation contract at spawn composition. */
export function createReviewerAssignment(input: ReviewerAssignment): ReviewerAssignment {
  if (input.authorInstanceId === input.reviewerInstanceId) throw new Error('REVIEWER_MUST_DIFFER_FROM_AUTHOR');
  return { ...input, artifacts: [...input.artifacts] };
}
