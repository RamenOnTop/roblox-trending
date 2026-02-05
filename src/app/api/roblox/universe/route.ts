// app/roblox/universe/route.ts
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const placeId = url.searchParams.get("placeId");

  if (!placeId) {
    return NextResponse.json({ error: "Missing placeId" }, { status: 400 });
  }

  const robloxRes = await fetch(
    `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`,
    { cache: "no-store" }
  );

  if (!robloxRes.ok) {
    return NextResponse.json(
      { error: `Roblox API failed: ${robloxRes.status}` },
      { status: 502 }
    );
  }

  const data = (await robloxRes.json()) as { universeId?: number };

  if (!data?.universeId) {
    return NextResponse.json(
      { error: "Could not resolve universeId from placeId" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    placeId: Number(placeId),
    universeId: data.universeId,
  });
}
