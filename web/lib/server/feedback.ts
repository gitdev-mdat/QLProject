import 'server-only';
import { db } from './db';
import { withTx } from './admin';
import { recordLeadReview } from '../../../src/lead-engagement';
import {
  claimFeedbackInvitation, declineFeedbackInvitation, getAdminFeedbackReport, recordLeadSourceOpen, submitCustomerFeedback,
  type FeedbackAnswers, type FeedbackFilter,
} from '../../../src/customer-feedback';

export type { AdminFeedbackReport, AdminFeedbackItem, FeedbackFilter } from '../../../src/customer-feedback';

/** Every customer call is scoped to the session's own user id; nothing here accepts a user id from the browser. */
export const recordSourceOpen = (userId: string, postId: string) => withTx(async client => {
  const owned = await recordLeadSourceOpen(client, userId, postId);
  if (owned) await recordLeadReview(client, userId, postId, 'source_open');
  return owned;
});
export const claimInvitation = (userId: string, resumeToken: string | null) => claimFeedbackInvitation(db(), userId, { resumeToken });
export const declineInvitation = (userId: string) => declineFeedbackInvitation(db(), userId);
export const submitFeedback = (userId: string, answers: FeedbackAnswers) => withTx(client => submitCustomerFeedback(client, userId, answers));

/** Admin only: callers must have passed requireAdmin()/adminApiGuard() first. */
export const adminFeedbackReport = (filter: FeedbackFilter, limit: number, offset: number) => getAdminFeedbackReport(db(), { filter, limit, offset });
