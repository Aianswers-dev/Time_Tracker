import { Link } from 'react-router';

export function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted">There is nothing at this address.</p>
      <Link
        to="/"
        className="inline-flex min-h-14 items-center rounded-xl bg-accent px-6 font-medium text-accent-fg"
      >
        Back home
      </Link>
    </main>
  );
}
