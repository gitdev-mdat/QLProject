import 'server-only';
import { withTx } from './admin';
import { deleteUserAccount as deleteAccount, previewUserDeletion as preview, type UserDeletionImpact, UserDeletionError } from '../../../src/user-deletion';

export type { UserDeletionImpact };
export { UserDeletionError };

export function previewUserDeletion(userId: string): Promise<UserDeletionImpact> {
  return preview(userId, withTx);
}

export function deleteUserAccount(actorId: string, targetId: string, confirmedTargetId: string): Promise<UserDeletionImpact> {
  const protectedAdmins = new Set((process.env.QLEAD_ADMIN_USER_IDS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  return deleteAccount(actorId, targetId, confirmedTargetId, protectedAdmins, withTx);
}
