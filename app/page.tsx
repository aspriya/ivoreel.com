import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">ivoreel</h1>
      <p className="text-muted-foreground">
        AI Faceless Reel Composer — 1080×1920 vertical video.
      </p>
      <div className="flex gap-2">
        <Link
          href="/create"
          className="rounded bg-foreground px-4 py-2 text-background"
        >
          Create Reel
        </Link>
        <Link
          href="/dashboard"
          className="rounded border px-4 py-2"
        >
          Dashboard
        </Link>
      </div>
    </main>
  );
}
