import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getToken } from '../api/client';
import { isStandalone } from '../lib/standalone';
import { lastPushHealth, subscribePushHealth } from './health';
import {
  isPushSupported,
  notificationPermission,
  storedSubscriptionId,
  type PermissionState,
  type PushHealth,
} from './push';

export interface PushState {
  supported: boolean;
  standalone: boolean;
  permission: PermissionState;
  /** Undefined while loading. */
  connected: boolean | undefined;
  /** The server id of this phone's subscription; null when off, undefined while loading. */
  subscriptionId: string | null | undefined;
  /** The latest background health check. */
  health: PushHealth | null;
  /** Re-read the permission, which has no change event on iOS. */
  refreshPermission: () => void;
}

/** Everything the notifications section needs to pick what to show. */
export function usePushState(): PushState {
  const [permission, setPermission] = useState<PermissionState>(notificationPermission);
  const refreshPermission = useCallback(() => setPermission(notificationPermission()), []);

  // The owner may change the permission in iOS Settings and come back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshPermission();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshPermission);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshPermission);
    };
  }, [refreshPermission]);

  const token = useLiveQuery(() => getToken(), []);
  const subscriptionId = useLiveQuery(() => storedSubscriptionId(), []);
  const health = useSyncExternalStore(subscribePushHealth, lastPushHealth, () => null);

  return {
    supported: isPushSupported(),
    standalone: isStandalone(),
    permission,
    connected: token === undefined ? undefined : token !== null,
    subscriptionId,
    health,
    refreshPermission,
  };
}
