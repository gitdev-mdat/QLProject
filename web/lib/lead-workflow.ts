/** Follow-up states a salesperson moves a lead through. Shared by server and client. */
export const LEAD_STATUSES = ['new', 'seen', 'contacted', 'interested', 'not_fit'] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];

export const statusLabel: Record<LeadStatus, string> = {
  // 'new' means the user has not opened the lead yet (it becomes 'seen' on open); it says nothing about post age.
  new: 'Chưa xem',
  seen: 'Đã xem',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  not_fit: 'Không phù hợp',
};

export type LeadNote = { id: string; body: string; createdAt: string };
export type LeadWorkflow = { status: LeadStatus; updatedAt: string | null; notes: LeadNote[] };
export type WorkflowMap = Record<string, LeadWorkflow>;

export const emptyWorkflow: LeadWorkflow = { status: 'new', updatedAt: null, notes: [] };
