/** Follow-up states a salesperson moves a lead through. Shared by server and client. */
// Existing customer filter options stay stable until the assigned UX integration is updated.
export const LEAD_STATUSES = ['new', 'seen', 'contacted', 'interested', 'not_fit'] as const;
export const LEAD_STATUS_VALUES = [...LEAD_STATUSES, 'not_interested'] as const;
export type LeadStatus = typeof LEAD_STATUS_VALUES[number];

export const statusLabel: Record<LeadStatus, string> = {
  // 'new' means the user has not opened the lead yet (it becomes 'seen' on open); it says nothing about post age.
  new: 'Chưa xem',
  seen: 'Đã xem',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  not_fit: 'Không phù hợp',
  not_interested: 'Không quan tâm',
};

export type LeadNote = { id: string; body: string; createdAt: string };
export type LeadWorkflow = { status: LeadStatus; updatedAt: string | null; notes: LeadNote[] };
export type WorkflowMap = Record<string, LeadWorkflow>;

export const emptyWorkflow: LeadWorkflow = { status: 'new', updatedAt: null, notes: [] };
