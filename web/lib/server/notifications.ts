import 'server-only';
import { db } from './db';
import { countUnreadNotifications, listAccountNotifications, markNotificationsRead } from '../../../src/account-notifications';
import type { AccountNotification } from '../../../src/account-notifications';

export type { AccountNotification };

/** Every call is scoped to the session's own user id; nothing here accepts a user id from the browser. */
export const listNotifications = (userId: string) => listAccountNotifications(db(), userId);
export const unreadNotificationCount = (userId: string) => countUnreadNotifications(db(), userId);
export const markRead = (userId: string, ids: string[]) => markNotificationsRead(db(), userId, ids);
