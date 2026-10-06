import { ChartColumn, CalendarDays, Settings, Timer, type LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router';

const TABS: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/', label: 'Now', icon: Timer },
  { to: '/today', label: 'Today', icon: CalendarDays },
  { to: '/stats', label: 'Stats', icon: ChartColumn },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function TabBar() {
  return (
    <nav
      aria-label="Main"
      className="tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur"
    >
      <ul className="mx-auto grid h-[var(--tabbar-h)] max-w-md grid-cols-4">
        {TABS.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex">
            <NavLink
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                  isActive ? 'text-accent' : 'text-muted'
                }`
              }
            >
              <Icon size={24} aria-hidden />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
