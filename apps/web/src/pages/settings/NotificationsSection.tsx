import {
  AlertTriangle,
  Bell,
  BellOff,
  CloudOff,
  Send,
  Share,
  SquarePlus,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../../components/toast';
import { Button, ErrorText } from '../../components/ui';
import {
  deleteSubscription,
  listSubscriptions,
  sendTestNotification,
  type ServerSubscription,
} from '../../push/api';
import { pushErrorFromApi } from '../../push/errors';
import { deviceLabel, isAppleMobile, timeAgo } from '../../push/format';
import { runPushHealthCheck } from '../../push/health';
import {
  disableNotifications,
  enableNotifications,
  reregister,
  type DisableResult,
} from '../../push/push';
import { usePushState, type PushState } from '../../push/usePushState';
import { SwitchRow } from './rules/fields';
import { Section } from './Section';

/**
 * Push notifications (docs/05 "Notifications", docs/06 "Push permission flow").
 * Which body shows depends on, in order: installed to the Home Screen, push
 * support, a server token, the permission, and whether this phone subscribed.
 */
export function NotificationsSection() {
  const state = usePushState();
  if (state.connected === undefined || state.subscriptionId === undefined) return null;
  const { supported, standalone } = state;

  return (
    <Section title="Notifications" id="notifications">
      <div className="flex flex-col gap-4">
        {!standalone && <InstallSteps canTryHere={supported} />}
        {standalone && !supported && (
          <Notice
            icon={<BellOff size={22} aria-hidden />}
            title="Not available on this iOS version"
          >
            Web app notifications need iOS 16.4 or later. Update iOS in Settings → General →
            Software Update, then come back here.
          </Notice>
        )}
        {supported && <Body state={state} />}
      </div>
    </Section>
  );
}

function Body({ state }: { state: PushState }) {
  if (!state.connected) return <ConnectFirst />;
  if (state.permission === 'denied') return <Denied />;
  return <Controls state={state} />;
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-1 text-sm leading-snug text-muted">{children}</div>
      </div>
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-2 flex flex-col gap-2 text-sm text-fg">{children}</ol>;
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="tabular inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
        {n}
      </span>
      <span className="min-w-0 pt-0.5 leading-snug">{children}</span>
    </li>
  );
}

function InstallSteps({ canTryHere }: { canTryHere: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <Notice icon={<Bell size={22} aria-hidden />} title="Install to Home Screen first">
        iPhone only delivers notifications to web apps on the Home Screen.
        <Steps>
          <Step n={1}>
            In Safari, tap Share{' '}
            <Share size={16} className="inline-block align-[-3px]" aria-label="(the Share icon)" />
          </Step>
          <Step n={2}>
            Tap Add to Home Screen{' '}
            <SquarePlus size={16} className="inline-block align-[-3px]" aria-hidden />, then Add
          </Step>
          <Step n={3}>Open Time Tracker from the Home Screen and come back here</Step>
        </Steps>
      </Notice>
      {canTryHere && (
        <p className="rounded-2xl bg-surface-2 px-4 py-3 text-xs leading-snug text-muted">
          This browser supports push, so you can still turn notifications on here to try them out.
        </p>
      )}
    </div>
  );
}

function scrollToSync() {
  const target = document.getElementById('sync-h') ?? document.getElementById('sync');
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ConnectFirst() {
  return (
    <div className="flex flex-col gap-3">
      <Notice icon={<CloudOff size={22} aria-hidden />} title="Connect to your server first">
        Your server sends the nudges, so the app needs your token before it can turn them on. Add it
        under Sync.
      </Notice>
      <Button onClick={scrollToSync}>Go to Sync</Button>
    </div>
  );
}

function Denied() {
  const ios = isAppleMobile(navigator.userAgent);
  return (
    <Notice icon={<BellOff size={22} aria-hidden />} title="Notifications are blocked">
      {ios ? (
        <>
          iOS won’t ask again from inside the app. To allow them:
          <Steps>
            <Step n={1}>Open the iOS Settings app</Step>
            <Step n={2}>Tap Notifications, then Time Tracker</Step>
            <Step n={3}>Turn on Allow Notifications and come back here</Step>
          </Steps>
        </>
      ) : (
        'This browser blocked notifications for this site. Allow them in the site settings (the icon left of the address), then reload.'
      )}
    </Notice>
  );
}

const REPAIRED: Record<'resubscribed' | 'reposted' | 'rekeyed', string> = {
  resubscribed: 'iOS had dropped this phone’s subscription, so it was set up again.',
  reposted: 'This phone’s subscription changed, so it was registered again.',
  rekeyed: 'Your server’s push key changed, so this phone subscribed again with the new one.',
};

/** Delivery for one subscription: when it last worked, or that it is failing. */
function delivery(s: ServerSubscription, at: number): { text: string; failing: boolean } {
  if (s.lastSuccessAt) return { text: timeAgo(s.lastSuccessAt, at), failing: false };
  if (s.failureCount > 0) return { text: 'Not delivering', failing: true };
  return { text: 'Nothing yet', failing: false };
}

function Controls({ state }: { state: PushState }) {
  const toast = useToast();
  const { permission, subscriptionId, health, refreshPermission } = state;
  const on = subscriptionId !== null && permission === 'granted';
  const [busy, setBusy] = useState<'toggle' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusKey, setStatusKey] = useState(0);
  const reloadStatus = useCallback(() => setStatusKey((k) => k + 1), []);

  function toggle(next: boolean) {
    setError(null);
    setBusy('toggle');
    // Called synchronously inside the tap: iOS only shows the permission
    // prompt for a request made within the user gesture.
    const pending: Promise<string | DisableResult> = next
      ? enableNotifications()
      : disableNotifications();
    pending
      .then((result) => {
        if (typeof result === 'string') {
          toast.show({ message: 'Notifications are on. Send a test to check.' });
          reloadStatus();
        } else if (result.serverWarning) {
          toast.show({
            message: `Turned off on this phone. ${result.serverWarning}`,
            tone: 'error',
          });
        } else {
          toast.show({ message: 'Notifications are off' });
        }
      })
      .catch((err: unknown) => setError(pushErrorFromApi(err).message))
      .finally(() => {
        setBusy(null);
        refreshPermission();
      });
  }

  async function test() {
    setBusy('test');
    setError(null);
    try {
      const { sent, failed } = await sendTestNotification();
      if (sent === 0 && failed === 0) {
        setError('Your server has no subscriptions to send to. Turn notifications off and on.');
      } else if (failed > 0) {
        toast.show({
          message: `Sent to ${sent}, failed for ${failed}. See the status below.`,
          tone: 'error',
        });
      } else {
        toast.show({ message: 'Test sent. It should arrive in a few seconds.' });
      }
      reloadStatus();
    } catch (err) {
      setError(pushErrorFromApi(err).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SwitchRow
        checked={on}
        disabled={busy !== null}
        onChange={toggle}
        icon={
          on ? (
            <Bell size={22} className="shrink-0 text-accent" aria-hidden />
          ) : (
            <BellOff size={22} className="shrink-0 text-muted" aria-hidden />
          )
        }
        label="Nudges on this phone"
        description={
          busy === 'toggle'
            ? 'Working…'
            : on
              ? 'Your server sends them once a minute when a rule is due.'
              : 'Off. Turn on to get nudged by your rules.'
        }
      />
      <ErrorText>{error}</ErrorText>
      {health?.status === 'error' && (
        <div className="flex flex-col gap-2 rounded-2xl bg-warn-bg p-3 text-warn-fg">
          <p className="flex gap-2 text-sm">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
            <span>Couldn’t keep this phone registered for notifications. {health.message}</span>
          </p>
          <Button onClick={() => void runPushHealthCheck().then(reloadStatus)}>Try again</Button>
        </div>
      )}
      {health?.status === 'repaired' && (
        <p className="text-xs text-muted">{REPAIRED[health.action]}</p>
      )}
      {on && subscriptionId && (
        <>
          <ServerStatus id={subscriptionId} reloadKey={statusKey} onChanged={reloadStatus} />
          <Button onClick={() => void test()} disabled={busy !== null}>
            <Send size={18} aria-hidden />
            {busy === 'test' ? 'Sending…' : 'Send test notification'}
          </Button>
        </>
      )}
    </div>
  );
}

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; all: ServerSubscription[]; at: number };

interface StatusProps {
  id: string;
  reloadKey: number;
  onChanged: () => void;
}

/** What the server knows about this phone's subscription, from `GET /api/push/subscriptions`. */
function ServerStatus({ id, reloadKey, onChanged }: StatusProps) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  // 'working' while registering again; otherwise the last failure, if any.
  const [repair, setRepair] = useState<{ working: boolean; error: string | null }>({
    working: false,
    error: null,
  });
  const repaired = useRef(false);

  useEffect(() => {
    let live = true;
    listSubscriptions()
      .then((all) => {
        if (live) setStatus({ kind: 'loaded', all, at: Date.now() });
      })
      .catch((err: unknown) => {
        if (live) setStatus({ kind: 'error', message: pushErrorFromApi(err).message });
      });
    return () => {
      live = false;
    };
  }, [id, reloadKey]);

  const mine = status.kind === 'loaded' ? status.all.find((s) => s.id === id) : undefined;
  const missing = status.kind === 'loaded' && !mine;

  const registerAgain = useCallback(() => {
    setRepair({ working: true, error: null });
    reregister()
      .then(() => {
        setRepair({ working: false, error: null });
        onChanged();
      })
      .catch((err: unknown) => setRepair({ working: false, error: pushErrorFromApi(err).message }));
  }, [onChanged]);

  // The server forgot this phone (for example it dropped it after failed
  // sends): register it again once on its own; after that, offer a button.
  useEffect(() => {
    if (missing && !repaired.current) {
      repaired.current = true;
      registerAgain();
    }
  }, [missing, registerAgain]);

  if (status.kind === 'loading') {
    return <p className="px-1 text-sm text-muted">Checking with your server…</p>;
  }
  if (status.kind === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-sm text-danger">Couldn’t load the status. {status.message}</p>
        <Button className="shrink-0" onClick={onChanged}>
          Retry
        </Button>
      </div>
    );
  }
  const others = status.all.filter((s) => s.id !== id);
  const mineDelivery = mine ? delivery(mine, status.at) : null;

  return (
    <div className="flex flex-col gap-3">
      {mine && mineDelivery ? (
        <div>
          <dl className="divide-y divide-line rounded-2xl border border-line px-4">
            <Row label="Last delivered" warn={mineDelivery.failing}>
              {mineDelivery.text}
            </Row>
            <Row label="Failed deliveries" warn={mine.failureCount > 0}>
              {mine.failureCount === 0 ? 'None' : mine.failureCount}
            </Row>
          </dl>
          {mineDelivery.failing && (
            <p className="mt-2 px-1 text-xs leading-snug text-muted">
              Your server hasn’t reached this phone yet. Send a test; if it still fails, turn
              notifications off and on again.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-2xl bg-warn-bg p-3 text-warn-fg">
          <p className="flex gap-2 text-sm">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {repair.working
                ? 'Your server doesn’t know this phone. Registering it again…'
                : `Your server doesn’t know this phone, so it can’t nudge it.${
                    repair.error ? ` ${repair.error}` : ''
                  }`}
            </span>
          </p>
          {!repair.working && <Button onClick={registerAgain}>Register again</Button>}
        </div>
      )}
      {others.length > 0 && <OtherDevices devices={others} at={status.at} onChanged={onChanged} />}
    </div>
  );
}

function Row({ label, children, warn }: { label: string; children: ReactNode; warn?: boolean }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`tabular text-sm font-medium ${warn ? 'text-danger' : ''}`}>{children}</dd>
    </div>
  );
}

interface OthersProps {
  devices: ServerSubscription[];
  at: number;
  onChanged: () => void;
}

/** Other subscriptions the server sends to, such as an old install. Each can be removed. */
function OtherDevices({ devices, at, onChanged }: OthersProps) {
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(device: ServerSubscription) {
    setRemoving(device.id);
    try {
      await deleteSubscription(device.id);
      toast.show({ message: `${deviceLabel(device.userAgent)} removed` });
      onChanged();
    } catch (err) {
      toast.show({ message: pushErrorFromApi(err).message, tone: 'error' });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      <p className="px-1 pb-1 text-sm text-muted">
        Also sending to {devices.length} other {devices.length === 1 ? 'device' : 'devices'}:
      </p>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {devices.map((d) => {
          const { text, failing } = delivery(d, at);
          return (
            <li key={d.id} className="flex items-center gap-2 pl-4">
              <span className="min-w-0 flex-1 py-2">
                <span className="block truncate text-sm font-medium">
                  {deviceLabel(d.userAgent)}
                </span>
                <span className={`block text-xs ${failing ? 'text-danger' : 'text-muted'}`}>
                  {d.lastSuccessAt ? `Last delivered ${text}` : text}
                  {d.failureCount > 0 ? ` · ${d.failureCount} failed` : ''}
                </span>
              </span>
              <button
                type="button"
                className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl text-danger active:bg-surface-2 disabled:opacity-40"
                aria-label={`Remove ${deviceLabel(d.userAgent)}`}
                disabled={removing !== null}
                onClick={() => void remove(d)}
              >
                <Trash2 size={18} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
