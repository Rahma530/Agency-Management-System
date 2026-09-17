import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationRecord } from '../types/database';

export type BusinessNotificationInput = {
  id: string;
  recipientId: string | null | undefined;
  title: string;
  message: string;
  senderId: string;
  type?: NotificationRecord['type'];
  linkUrl: string;
  createdAt?: string;
};

/**
 * Inserts one persistent business notification through the existing RLS-protected table.
 * A deterministic primary-key conflict means this event was already delivered, so it is a
 * successful no-op. Other notification failures are logged and never undo the business action.
 */
export async function createBusinessNotification(
  client: SupabaseClient,
  input: BusinessNotificationInput
): Promise<'created' | 'duplicate' | 'skipped' | 'failed'> {
  if (!input.recipientId) return 'skipped';

  const notification: NotificationRecord = {
    id: input.id,
    user_id: input.recipientId,
    title: input.title,
    message: input.message,
    sender_id: input.senderId,
    is_read: false,
    type: input.type || 'general',
    link_url: input.linkUrl,
    created_at: input.createdAt || new Date().toISOString(),
  };

  try {
    const { error } = await client.from('notifications').insert(notification);
    if (!error) return 'created';
    if (error.code === '23505') return 'duplicate';
    console.error('Failed to create business notification:', { notificationId: notification.id, error });
  } catch (error) {
    console.error('Failed to create business notification:', { notificationId: notification.id, error });
  }

  return 'failed';
}
