import { Badge } from '@qm/ui';
import { createContext, useContext, type ReactNode } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation } from '../../auth/current.ts';
import { useUnreadChat } from './api.ts';

/** Unread guest messages per visit id, provided by the console page. */
export const UnreadChatContext = createContext<Record<string, number>>({});

const NONE: Record<string, number> = {};

/** Reads the current location's unread guest messages once and shares them with every row. */
export function UnreadChatProvider({ children }: { children: ReactNode }) {
  const { location } = useCurrentLocation();
  const unread = useUnreadChat(location?.id);
  return (
    <UnreadChatContext.Provider value={unread.data ?? NONE}>{children}</UnreadChatContext.Provider>
  );
}

/** "N new messages" on a row, so staff notice a guest wrote without opening the sheet. */
export function ChatBadge({ visitId }: { visitId: string }) {
  const { t } = useTranslation('staff');
  const count = useContext(UnreadChatContext)[visitId] ?? 0;
  if (count === 0) return null;
  return (
    <Badge tone="info" data-testid="chat-badge" aria-label={t('console.chat.unread', { count })}>
      {t('console.chat.badge', { count })}
    </Badge>
  );
}
