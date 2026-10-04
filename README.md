# Roblox Trends

The frontend now offers a dark research dashboard with selectable game and genre charts, search, genre filters, sorting, and a browser-local watchlist. The watchlist does not require a login and does not sync across devices. Game detail links use `/game/?id=...` in both local and Pages builds. Run `npm run collect` to generate the local frontend dataset before `npm run dev`; the original API routes remain available independently.

Recent charts include raw observations from the last 24 hours, together with the existing 30-day hourly history, within the configured history row budget. The collector exports individual game history files under `public/data/games/` so selecting a game does not download every game's full history. Table sparklines use a small set of real observations; growth is the actual percentage change in counts across the available window, and zero baselines remain unavailable. No database schema changes are required for this frontend update.

### Breakout research

The **Breakouts** tab shows up to five steady growers for 3, 6, or 24 hours, primary genre filters, a genre summary, watchlist stars, and links to full game charts. `scripts/lib/breakouts.mjs` derives these observations from existing history during collection; schema version 4 adds per-game `breakouts` records. No new Roblox API calls, Supabase tables, or browser database queries are needed. Older published datasets show a waiting state until the next collection. A snapshot older than 75 minutes shows a freshness notice.

Starting audience determines the simultaneous player-gain and percentage thresholds:

| Starting players | Minimum gain | Minimum growth | Minimum ending players |
| --- | --- | --- | --- |
| Under 1,000 | 100 | 30% | 200 |
| 1,000–9,999 | 300 | 20% | — |
| 10,000–74,999 | 1,000 | 10% | — |
| 75,000+ | 3,000 | 8% | — |

Require a baseline within 20 minutes of the requested start, at least 90% of the window, four valid observations, latest observation no older than 45 minutes relative to collection, and no gap exceeding 45 minutes (75 for the 24-hour window). Zero baselines, negative/invalid counts, duplicates and future observations cannot fabricate qualification. Gains must meet both thresholds across at least three recent observations spanning at least 54 minutes. A single increase contributing at least 70% of net gain is a separate **Single jump** signal; more than 25% below the observed peak is **Cooling off**; growth that has not held long enough is **Early movement**. These signals never fill missing top-five slots.

Ranking uses 60% of percentage growth divided by its tier threshold plus 40% of player gain divided by its tier threshold; each ratio is capped at 3. Ties use percentage growth, then game ID for deterministic ordering. Genre summaries count qualifying tracked games and show the total tracked cohort. Existing genre `breakoutsCount` now counts validated 24-hour steady growers, with explicit `breakoutsWindowHours: 24`, independently of the genre chart range.

These are untrained screening rules, not forecasts or measured probabilities. Daily audience cycles, updates and events can qualify. The ML experiment remains separate and must beat time-ordered baselines before live predictions are introduced.

A Next.js dashboard for exploring Roblox genre momentum. GitHub Pages serves the static frontend; GitHub Actions collects public Roblox statistics and publishes the dashboard dataset. Supabase is optional for the first live snapshot and required for durable history, growth comparisons, and future ML training.

## GitHub Pages and Actions

Repository: https://github.com/RamenOnTop/roblox-trending

Expected site: https://ramenontop.github.io/roblox-trending/

In repository Settings → Pages, choose **GitHub Actions** as the source. Supabase Cron triggers the collection and deployment workflow at minutes 13 and 43 of each hour. Pushes to main and manual dispatch also run it. Timestamps represent actual collection times; runner queues and upstream failures can delay updates. The overview checks for published updates every minute while visible and when returning to the tab, preserving the selected game. Refreshing the page does not collect new Roblox data; collection still runs in Actions.

The separate check workflow runs collector tests and a static production build on pull requests and pushes. Checks do not access Supabase or Roblox.

### Supabase collection timer

`database/scheduleCollection.sql` installs the Supabase Cron timer that triggers the existing Actions workflow at minutes 13 and 43. It requires a fine-grained GitHub token scoped only to `RamenOnTop/roblox-trending`, with Actions read and write, saved in Supabase Vault as `robloxWorkflowToken`. The current scheduler token expires December 31, 2026; renew it in GitHub and update the Vault entry before expiry. Save the credential through Vault; do not paste it into source control, chat, or a saved SQL snippet. The setup refuses to activate without the secret.

The administrator-only dispatcher uses a fixed GitHub destination and reads its credential at runtime. A recent running collection suppresses duplicate requests, while records older than the 25-minute build timeout do not prevent recovery. Re-running setup updates the existing timer by name. Check the returned request ID in `net._http_response`, then verify the Actions run and live dashboard timestamp: cron success alone only means an HTTP request was queued, not that GitHub accepted it or collection succeeded.

The workflow retains push, manual dispatch and concurrency protection; its native GitHub schedule is removed after verifying the Supabase trigger. Pause the Supabase job with `cron.alter_job` as shown in the SQL file. A paused Supabase project, expired token, GitHub runner issue, or Roblox failure can still interrupt collection; inspect the Cron history, HTTP responses and Actions logs. Clean up old Cron run history periodically because Supabase does not remove it automatically.

Without database secrets, deployment shows a current snapshot and explicitly reports that historical comparisons are unavailable. Each deployment replaces that snapshot; GitHub Pages is not a historical database. Missing observations are not converted to zero-player counts. A failed collection prevents deployment, preserving the previously published site.

### Connect a fresh Supabase dataset

For an existing dataset, run **database/addEnrichment.sql** once in Supabase SQL Editor. This additive migration creates `trendEnrichment` and preserves all collected games and history. Do not rerun the destructive reset script. Existing Actions secrets continue to work.

The collector requests batched game icons and up to three promotional thumbnails per game. Badge and recommendation details refresh for up to 20 games per run, rotating the oldest checks first with a 24-hour refresh interval and a 120-second enrichment budget. Badge lists contain at most 10 entries and indicate when more pages exist. Award counts are badge statistics, not unique players or retention. User-owned games also receive a bounded public creator-games list; group-owned portfolios are not queried through the user endpoint.

`trendEnrichment` stores one row per game (`gameId`, JSONB `payload`, `refreshedAt`). Payload includes image URLs, badge samples and award counts, recommendations, user creator-games lists, and per-feature collection timestamps. It caches current details; historical player observations remain in the snapshot tables. Recommendations in the cache add candidates to the next collection within the existing tracking cap. They are Roblox recommendations, not our own similarity model.

Optional enrichment errors preserve cached values and allow core stats collection to succeed. Until the migration is applied, images and a limited detail sample can appear on Pages, but details cannot be cached or rotated across runs. Public API requests run in GitHub Actions; the browser reads the generated dataset without database credentials. Private Analytics Query API calls are not enabled: they require an experience-scoped Roblox API key and authorization.

References: [Thumbnails](https://create.roblox.com/docs/cloud/reference/domains/thumbnails), [Badges](https://create.roblox.com/docs/cloud/reference/domains/badges), [Games and recommendations](https://create.roblox.com/docs/cloud/reference/domains/games), [Analytics permissions](https://create.roblox.com/docs/cloud/guides/analytics).

1. Run [database/freshDataset.sql](database/freshDataset.sql) in the fresh project's SQL Editor. It creates new tables; it does not wipe existing data.
2. Add two repository Actions secrets under Settings → Secrets and variables → Actions:
   - **supabaseUrl**: the project URL.
   - **supabaseServiceKey**: the server-side service-role key for that project.
3. Run **Collect Roblox data and deploy Pages** manually from the Actions tab.

Keep credentials out of source files, public environment variables, generated JSON, and Git commits. If only one secret is configured or the schema is missing, collection fails instead of silently pretending history was saved.

| Table | Purpose |
| --- | --- |
| trendGames | Public game metadata and the saved tracking registry |
| trendSnapshots | Raw observations for analytics and future ML |
| trendHourlySamples | Latest observation per game per hour for compact dashboard history |
| collectionRuns | Collection timing, success/failure, and warnings |

Row-level security is enabled without public read/write policies. Only the server worker receives the database key. The published JSON contains public Roblox metadata and derived statistics.

### Lower bandwidth and preserve ML history

The collector restores a compressed checkpoint from GitHub Actions cache. Known games fetch observations since the previous successful collection, with a one-hour overlap for late writes. Newly tracked games backfill recent raw observations and hourly history once. Hourly rows replace the previous observation in the same bucket; charts do not invent observations. Cached enrichment avoids downloading every game's full detail payload on each run. Checkpoints are bound to the database URL and history-window configuration; missing, corrupt or evicted caches rebuild from Supabase. A partial historical download cannot advance the checkpoint.

Run **database/optimizeHistory.sql** once in the existing Supabase project's SQL Editor. This additive migration creates the archive ledger, incremental hourly index and server-only maintenance functions. Running the SQL itself does not delete history. The bandwidth optimization works before this migration; archive retention remains inactive until it is installed.

With the migration installed, completed UTC days of raw observations are compressed into JSONL/GZIP assets in the **roblox-history** GitHub release. All original snapshot columns, including votes, visits, favorites and collection IDs, are retained. Each asset has a SHA-256 manifest. The worker uploads both files, downloads them from GitHub, checks their bytes and row counts, and asks PostgreSQL to confirm that the source has not changed before registering the archive or deleting anything. Failed archive maintenance leaves unverified rows in Supabase and does not stop the frontend deployment. Release assets contain public Roblox statistics and are publicly downloadable; credentials are excluded.

Supabase retains at least seven completed days of raw snapshots plus the current UTC day, and at least 35 days of hourly samples. Older hourly rows are eligible for deletion only when the corresponding raw day has a verified archive and its raw snapshot is no longer present. The cache keeps recent raw chart observations and about 31 days of hourly history. `historyDays` describes dashboard coverage, not the lifetime of the ML dataset. The game tracking cap remains 1,000.

**Keep the roblox-history release assets.** They hold the raw training history after pruning; Actions cache is disposable performance state, not the ML archive. If a historical day changes after archival, a new immutable asset is added and previous versions remain available. When assembling training data across versions, deduplicate by game ID and capture timestamp. Keep a separate copy of release archives for an independent backup. Deleted database pages are normally reused by PostgreSQL; pruning does not guarantee an immediate reduction in reported database size.

Collection logs and published metadata include `historyMode`, `historyRowsDownloaded`, `historyJsonBytesDownloaded` and `enrichmentRowsDownloaded`. JSON byte counts describe decoded historical payloads, not exact billed egress. Compare warmed runs and monitor Supabase's actual storage/egress usage. These changes reduce repeated downloads and bound hot history; they do not guarantee every workload fits the free plan.

## Roblox request strategy

The collector uses universe IDs as game identifiers; a root place ID is used only for Roblox game links.

1. Discover chart games through **https://apis.roblox.com/explore-api/v1/get-sort-content** with a sort ID and generated session ID. This endpoint worked in a live smoke check, but is not listed in the Creator Hub public API reference. It is isolated behind discoverGames and must not be treated as a stable, complete enumeration of Roblox.
2. Combine discovered IDs with configured seeds and previously tracked IDs. With Supabase connected, games continue to be requested after disappearing from the chart, within the configured tracking cap.
3. Request game details through the documented public batch endpoint **https://games.roblox.com/v1/games?universeIds=...**. Use player counts, visits, favorites, creation/update dates, creator, and genre fields.
4. Request vote counts through **https://games.roblox.com/v1/games/votes?universeIds=...**. This avoids using chart payloads as authoritative ratings and avoids one request per game. If vote requests fail, the worker records unknown ratings and a warning.
5. Use sequential batches of 50 IDs, 20-second request timeouts, and at most four attempts. Retry 429 and transient server/network errors with exponential backoff and jitter. Honor Retry-After; abort rather than retrying earlier than a long server-requested cooldown. No fixed quota or unlimited throughput is assumed.

No Roblox account cookie or Open Cloud key is needed for these public statistics. Avoid per-game server-list scraping to estimate concurrent players; the game-details endpoint already supplies that statistic. Roblox's permissioned creator analytics APIs should not be assumed to provide private retention, revenue, or historical metrics for arbitrary other creators' games.

The chart is a sample of popular games, not a catalog of all Roblox games. Add smaller games' universe IDs to **config/collection.json → seedUniverseIds** to improve coverage. The default tracking cap is 1,000 games. Historical reads use timestamp-plus-ID cursors so games sharing a collection timestamp are not skipped or repeatedly fetched.

### Sources consulted

- [Roblox games API reference](https://create.roblox.com/docs/cloud/reference/domains/games)
- [Roblox APIs reference](https://create.roblox.com/docs/cloud/reference/domains/apis)
- [Next.js static export support and limitations](https://nextjs.org/docs/app/guides/static-exports)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## Local commands

Run **npm ci**, **npm run test:data**, **npm run collect**, and **npm run build:pages**. The tests include embedded PostgreSQL checks for archive retention and source-change protection. **npm run archive:history** requires the existing Supabase credentials plus `githubRepository` and `githubToken`; Actions configures these automatically.

Collection makes real read-only requests to Roblox and writes ignored public/data/dashboard.json. If the supabaseUrl and supabaseServiceKey environment variables are present, it also writes to the configured fresh database. Avoid setting these variables unless that database is ready.

For a local export with the repository path, set pagesBasePath to /roblox-trending before building. The output is **.pagesBuild/out**. The build copies only frontend files into an isolated staging directory, excludes Next.js API routes and the server database client, and uses a static game detail page. It does not modify or publish .env.local.

**npm run dev** retains the original Next.js server mode and its existing API routes/schema. The GitHub Pages collector uses the fresh schema independently; connecting the old development API routes to that schema is a separate migration.

Current trend/opportunity scores remain formulas; no ML forecasts are published to the dashboard. The manual **Learn and evaluate player forecasts** workflow exports recent raw observations and compares persistence, a linear model and boosted trees using chronological validation and test periods. Its reports, examples and model are saved as downloadable experiment artifacts. Follow [the ML walkthrough](machineLearning/WALKTHROUGH.md) to run and understand each stage. These initial experiments do not establish prediction accuracy across weeks or unseen games.
