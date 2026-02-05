// app/roblox/game/route.ts
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const universeId = url.searchParams.get("universeId");

  if (!universeId) {
    return NextResponse.json({ error: "Missing universeId" }, { status: 400 });
  }

  const robloxRes = await fetch(
    `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`,
    {
      headers: { "User-Agent": "roblox-trends/1.0" },
      cache: "no-store",
    }
  );

  if (!robloxRes.ok) {
    return NextResponse.json(
      { error: `Roblox API failed: ${robloxRes.status}` },
      { status: 502 }
    );
  }

  const data = await robloxRes.json();
  return NextResponse.json(data);
}
