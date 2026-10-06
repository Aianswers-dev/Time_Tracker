import { AboutSection } from './settings/AboutSection';
import { CategoriesSection } from './settings/CategoriesSection';
import { DaySection } from './settings/DaySection';
import { ExportSection } from './settings/ExportSection';
import { NotificationsSection } from './settings/NotificationsSection';
import { RulesSection } from './settings/RulesSection';
import { SyncSection } from './settings/SyncSection';

/** Each section is its own component so milestones can fill them in independently. */
export function Settings() {
  return (
    <main className="flex flex-col gap-6 px-4 pt-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <CategoriesSection />
      <DaySection />
      <SyncSection />
      <NotificationsSection />
      <RulesSection />
      <ExportSection />
      <AboutSection />
    </main>
  );
}
