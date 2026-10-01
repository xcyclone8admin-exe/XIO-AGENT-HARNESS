/**
 * Independent BRAIN golden corpus. Each row is a reviewer-curated relevance label:
 * its source directly answers the query, while the surrounding test adds distractor
 * documents and measures the real authorized retrieval pipeline at k=10.
 */
export const GOLDEN_RETRIEVAL = [
  { id: 'retention-metric', query: 'monthly retention cohort metric', title: 'Customer retention measurement', content: 'The customer retention metric is calculated monthly by tracking each signup cohort and the share still active after thirty days.' },
  { id: 'refund-window', query: 'refund request window days', title: 'Refund policy', content: 'Customers may request a refund within fourteen calendar days of the original purchase date. The allowed refund request window is fourteen days.' },
  { id: 'warehouse-audit', query: 'warehouse inventory audit schedule', title: 'Warehouse controls', content: 'The warehouse schedule performs an inventory cycle count audit every Friday and a complete inventory reconciliation at quarter end.' },
  { id: 'incident-severity', query: 'security incident severity escalation', title: 'Incident response guide', content: 'A confirmed credential leak is classified as a high severity security incident; escalation of the incident sends it to the incident lead immediately.' },
  { id: 'invoice-approval', query: 'invoice approval spending threshold', title: 'Invoice approval matrix', content: 'Invoices above five thousand dollars require approval from both the department lead and finance before payment. The spending threshold is five thousand dollars.' },
  { id: 'release-window', query: 'release deployment maintenance window', title: 'Release operations', content: 'Production releases are scheduled for the Tuesday maintenance window after the change review is complete.' },
  { id: 'meeting-notes', query: 'meeting notes distribution deadline', title: 'Meeting documentation', content: 'The meeting owner distributes reviewed notes and action items to attendees within one business day.' },
  { id: 'backup-restore', query: 'database backup restore rehearsal', title: 'Backup recovery standard', content: 'The database backup is restored in an isolated environment during the monthly recovery rehearsal.' },
  { id: 'support-response', query: 'priority support response target', title: 'Support service levels', content: 'The priority support response target is an initial human response to priority one requests within thirty minutes.' },
  { id: 'vendor-review', query: 'vendor security review renewal', title: 'Vendor governance', content: 'Every active vendor completes a security review renewal annually and again before a material scope expansion.' },
  { id: 'data-retention', query: 'customer export deletion retention', title: 'Data lifecycle', content: 'Customer export deletion and retention policy sets an expiry after seven days; files are deleted from the private storage bucket.' },
  { id: 'training-record', query: 'employee safety training renewal', title: 'Workplace safety', content: 'Employees renew safety training every twelve months and managers retain completion records.' },
] as const;
