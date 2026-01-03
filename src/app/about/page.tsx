export default function AboutPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold">About / Method</h1>
        <p className="mt-3 text-zinc-400">
          This project detects trending Roblox experiences and clusters them into trending “types”
          (mechanics/genres).
        </p>

        <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <h2 className="text-lg font-semibold">Signals (planned)</h2>
          <ul className="mt-3 list-disc space-y-2 pl-6 text-zinc-300">
            <li>Active players and growth rate over time</li>
            <li>Like ratio / favorites velocity</li>
            <li>Visits velocity (acceleration matters)</li>
            <li>Tag/genre clustering (LLM + heuristics)</li>
          </ul>
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <h2 className="text-lg font-semibold">Current state</h2>
          <p className="mt-2 text-zinc-400">
            Step 1: Frontend + mock API route. Next: Supabase Postgres + scheduled ingest + scoring.
          </p>
        </div>
      </div>
    </div>
  );
}
