const INGEST_URL = "http://localhost:3000/api/ingest";
const INTERVAL_MS = 30 * 60 * 1000;

async function runOnce() {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-key": process.env.INGEST_KEY ?? "",
    },
    body: "{}",
  });

  const text = await res.text();
  console.log(new Date().toISOString(), res.status, text.slice(0, 200));
}

await runOnce();
setInterval(runOnce, INTERVAL_MS);
