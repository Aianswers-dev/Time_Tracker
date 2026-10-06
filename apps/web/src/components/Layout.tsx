import { Outlet } from 'react-router';
import { StatusPill } from './StatusPill';
import { TabBar } from './TabBar';
import { ToastProvider } from './ToastProvider';

export function Layout() {
  return (
    <ToastProvider>
      <StatusPill />
      <div className="pb-tabbar mx-auto flex min-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-md flex-col">
        <Outlet />
      </div>
      <TabBar />
    </ToastProvider>
  );
}
