// app/games/[id]/pages.tsx
import Link from "next/link";

type PageProps = {
  params: Promise<{ id: string }>;
};

type Game = {
  id: string;
  name: string;
  creator: string;
  tags: string[];
  activePlayers: number;
  growthPct: number;
  description: string;
};

export default async function GamePage({ params }: PageProps) {
  const { id } = await params;

  const Res = await fetch(`http://localhost:3000/api/game?id=${id}`, {
    cache: "no-store",
  });

  if (!Res.ok) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <Link className="text-sm text-zinc-400 hover:text-white" href="/">
            ← Back to Dashboard
          </Link>
          <p className="mt-6 text-zinc-400">Game not found.</p>
        </div>
      </div>
    );
  }

  const Data = (await Res.json()) as { game: Game };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm text-zinc-400 hover:text-white" href="/">
          ← Back to Dashboard
        </Link>

        <h1 className="mt-4 text-3xl font-bold">{Data.game.name}</h1>
        <p className="mt-2 text-zinc-400">by {Data.game.creator}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {Data.game.tags.map((Tag) => (
            <span key={Tag} className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-sm">
              {Tag}
            </span>
          ))}
        </div>

        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h2 className="text-lg font-semibold">Summary</h2>
              <p className="mt-2 text-zinc-300">{Data.game.description}</p>
            </div>

            <div className="text-right">
              <p className="text-sm text-zinc-400">Active</p>
              <p className="text-2xl font-bold">{Data.game.activePlayers.toLocaleString()}</p>
              <p className={Data.game.growthPct >= 0 ? "text-green-400" : "text-red-400"}>
                {Data.game.growthPct >= 0 ? "+" : ""}
                {Data.game.growthPct.toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
