// app/api/game/route.ts
import { NextResponse } from "next/server";

const AllGames = [
  { id: "129", name: "Blade Arena", creator: "Studio Nova", tags: ["PvP", "Arena", "Combat"], activePlayers: 48210, growthPct: 22.9, description: "Fast PvP arena combat." },
  { id: "205", name: "City Life RP", creator: "MetroWorks", tags: ["RP", "Social", "Open World"], activePlayers: 61190, growthPct: 11.7, description: "Social RP in an open world city." },
  { id: "311", name: "Tower Rush", creator: "Updraft Games", tags: ["Obby", "Speedrun", "Casual"], activePlayers: 32990, growthPct: 6.1, description: "Speedrun obby challenges." },
  { id: "404", name: "Murder Mystery Nights", creator: "Whodunit", tags: ["Social Deduction", "Round-Based", "Party"], activePlayers: 39840, growthPct: 9.3, description: "Round-based social deduction." },
  { id: "777", name: "Dungeon Gacha", creator: "LootLabs", tags: ["RPG", "Gacha", "Grinding"], activePlayers: 44310, growthPct: 18.4, description: "RPG grind + gacha loot." },
  { id: "909", name: "Tycoon Empire", creator: "Cashflow Co", tags: ["Tycoon", "Progression", "Idle"], activePlayers: 27110, growthPct: 16.8, description: "Build, upgrade, idle profit." },
];

export function GET(Request: Request) {
  const Url = new URL(Request.url);
  const id = Url.searchParams.get("id");

  const game = AllGames.find((g) => g.id === id);
  if (!game) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ game });
}
