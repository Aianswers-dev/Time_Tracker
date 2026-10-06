import { Link } from 'react-router';

export function NotFound() {
  return (
    <main className="flex flex-col items-start gap-4 px-4 pt-10">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted">There is nothing at this address.</p>
      <Link
        to="/"
        className="inline-flex min-h-14 items-center rounded-2xl bg-accent px-6 font-semibold text-accent-fg"
      >
        Back to Now
      </Link>
    </main>
  );
}
