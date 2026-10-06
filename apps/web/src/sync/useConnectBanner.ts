import { useLiveQuery } from 'dexie-react-hooks';
import { TOKEN_KEY } from '../api/client';
import { db } from '../db';
import { SYNC_META } from './meta';

/**
 * Whether the Now screen shows "Connect to your server": no token stored and
 * not dismissed. Undefined while loading, so the banner never flashes.
 */
export function useShowConnectBanner(): boolean | undefined {
  return useLiveQuery(async () => {
    const [token, dismissed] = await db.meta.bulkGet([TOKEN_KEY, SYNC_META.bannerDismissed]);
    return (!token || token.value.trim() === '') && dismissed === undefined;
  }, []);
}
