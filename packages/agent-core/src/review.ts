import type { ReviewerAssignment } from './contracts';

/** Enforces the reviewer/adversary isolation contract at spawn composition. */
export function createReviewerAssignment(input: ReviewerAssignment): ReviewerAssignment {
  if (input.authorInstanceId === input.reviewerInstanceId) throw new Error('REVIEWER_MUST_DIFFER_FROM_AUTHOR');
  return { ...input, artifacts: [...input.artifacts] };
}
