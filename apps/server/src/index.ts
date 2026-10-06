import { app, type Env } from './app';

export { app };
export type { Env };

export default {
  fetch: app.fetch,
  scheduled(controller) {
    // The rule engine arrives in M3. For now just log that the cron fired.
    console.log(
      JSON.stringify({
        event: 'scheduled',
        cron: controller.cron,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
