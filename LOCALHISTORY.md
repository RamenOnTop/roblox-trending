# Local Roblox history

Cloud collection still writes to Supabase independently of this PC. This local setup downloads the verified **roblox-history** release archives and imports completed UTC days into PostgreSQL. It does not change Supabase retention, delete cloud data, or move the website. Today's observations remain in the existing cloud pipeline until their completed-day archive is published.

## Catch up

Open Docker Desktop and wait for its engine to run. Then double-click `scripts/syncLocalHistory.cmd`, or run this from the repository:

```powershell
npm run history:sync
```

The command starts the database if necessary, downloads missing archives and manifests, verifies SHA-256, compressed size, header, row count, identities, dates and types, and imports each day in one transaction. PostgreSQL compares every imported row to its verified source before committing its ledger entry. Conflicting immutable versions stop the import without overwriting local observations. Identical overlapping observations have one local row. A repeat sync verifies cached archive files and skips already imported digests. An interrupted import can be retried; previously committed days remain available.

The current public game catalog is refreshed for names and genres. Those names describe the catalog's observation time, not historical metadata at the time of each player count. Missing archive days are explicitly listed in the final report. No missing observations are invented. Original anomalies, such as negative favorite counts, are retained and counted in the report.

## Inspect and query

```powershell
npm run history:status
npm run history:sql
```

The second command opens a PostgreSQL prompt. For example:

```sql
select g.name, s."gameId", s."capturedAt", s."activePlayers"
from "localHistory"."snapshots" s
left join "localHistory"."gameCatalog" g on g."gameId" = s."gameId"
where s."gameId" = '994732206'
order by s."capturedAt" desc
limit 20;
```

Type `\q` to exit the prompt. Other local database clients can connect to host `127.0.0.1`, port `55432`, database `robloxHistory`, user `historyOwner`. The randomly generated password is the `historyPassword` value in `.localHistory/runtime.env`. Keep that file local. The official PostgreSQL 17 image is pinned to its downloaded digest in the same file.

## Where the data lives

- Persistent PostgreSQL data: Docker volume **robloxTrendsHistoryData**, managed by Docker Desktop.
- Compressed independent source copies and manifests: `.localHistory/archives/` inside this repository, outside OneDrive at the current checkout location.
- Most recent sync report: `.localHistory/latestSync.json`.
- Most recent public metadata: `.localHistory/latestDashboard.json`.
- Private local configuration: `.localHistory/runtime.env`.

The entire `.localHistory/` folder is ignored by Git. The database port is bound to the loopback interface. Ordinary container stops and PC restarts preserve the Docker volume. Removing that volume or resetting Docker's stored data removes the local database; retained archive files can be reimported. Keep an additional archive copy on another drive for protection against failure of this PC.

```powershell
npm run history:stop
npm run history:start
```

The setup leaves other Docker projects alone. No Supabase keys are needed for archive sync. GitHub CLI must be installed and able to read the repository release. Node.js 22 or newer and Docker Compose are required.

## Cloud storage audit

`database/inspectStorage.sql` is a read-only query for the Supabase SQL Editor. It reports database size, table/index sizes, approximate live/dead rows, history coverage and recent archive/pruning records. Copying archives locally does not itself reduce Supabase size. Existing cloud pruning remains dependent on verified GitHub archives and the configured retention windows. Size and retention changes should be based on this audit.

## Verification

`node --test scripts/tests/localHistory.test.mjs` covers archive corruption and manifest mismatches, timestamp aliases, anomalous original values, full-row preservation, overlapping versions and transaction rollback on conflicting data. Actual imports additionally use PostgreSQL COPY and transactional row comparisons. The importer never calls Supabase deletion functions.
