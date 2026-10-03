# Learn player forecasting with Roblox Trends

This first experiment predicts concurrent players about one hour ahead. It is separate from the production website and its 30-minute collector. No new database tables or keys are required. The experiment reads raw observations; it does not change Supabase data or publish predictions to Pages.

## Run the first experiment

In GitHub, open **Actions → Learn and evaluate player forecasts → Run workflow → main → Run workflow**. The manual workflow already uses the existing Supabase secrets. It exports up to seven days of `trendSnapshots`, installs pinned Python libraries, runs safety checks, builds examples, trains candidates, and uploads an artifact named `forecastExperiment` followed by the run ID.

Open the completed run and download that artifact. Begin with **lesson.md**, then inspect **examples.csv** and **testPredictions.csv**. `report.json` contains the same results in a format programs can read; `audit.json` describes the source data. The artifact also includes the exact source observations and a saved selected model. Artifacts expire after 14 days, so download a run you want to keep. These are experiment artifacts, not the long-term history archives.

The script can be run locally using the isolated environment created in this project. Run these commands in **PowerShell**, from the repository folder:

```powershell
cd 'C:\Users\Aweso\ChatGPT\Roblox Trends\roblox-trends'
& '.\machineLearning\.venv\Scripts\python.exe' machineLearning/forecastExperiment.py --input 'C:\path\to\downloaded\observations.jsonl'
```

Replace the example input path with the file you extracted from our workflow artifact. Results are written to `machineLearning/output/`. Check their creation time to distinguish this run from older results. No credentials are needed to rerun training from that file.

For a different computer, install Python 3.12 from the official Python distribution, then create the environment:

```powershell
python -m venv machineLearning/.venv
& '.\machineLearning\.venv\Scripts\python.exe' -m pip install -r machineLearning/requirements.txt
```

`npm run ml:export` is also available, but it requires the existing server credentials in environment variables. Prefer GitHub's export step rather than copying those credentials to a local machine. They belong only in the export step, never in the CSV, report, or model.

## Lesson 1: observations are not training examples

An observation is a game ID, capture timestamp, and concurrent player count. Training needs two parts: **features**, which describe what was known at the prediction time, and a **label**, which records the later outcome.

Open `examples.csv` and find a row. `anchorTime` is the moment we pretend to make a prediction. `playersNow` is known then. `actualPlayers` is the answer recorded at `labelTime`. The label is not an input to the model.

The current script requires a usable three-hour history. It uses the first actual observation at least one hour after the anchor, at most ten minutes late. Therefore the forecast's measured outcome can be 60–70 minutes ahead; `labelTime` records the actual time. It never uses "two rows later" as a substitute for one hour, interpolates a missing answer, or treats missed collections as zero players.

Open `eligibility.json` to see how many observations became examples. Insufficient history and missing future outcomes are counted separately. Gaps longer than 45 minutes in the history window make an example ineligible. `audit.json` flags large changes without deleting them; Roblox events can produce real spikes.

## Lesson 2: understand the features and target

Read `featuresAt()` in **forecastExperiment.py**. It can see only the current point and preceding points. Features include current/lagged player counts, growth per hour, the recent mean, variation, peak, actual lag ages, and UTC hour/day represented around a circle.

We use `log(1 + players)` so a move from 100 to 200 and from 10,000 to 20,000 are closer in scale than their raw count differences. Zero players remains valid. This transformation changes the learning objective; it does not make data Gaussian or guarantee fair predictions.

The label is a log change: `log(1 + futurePlayers) - log(1 + playersNow)`. After predicting that change, we convert back into player counts. A predicted log change of zero is the persistence baseline: players stay the same.

Initial features use recorded counts and calendar time. Current game descriptions, genre changes, current update dates, and enrichment are excluded because we do not have their full historical versions. Adding today's metadata to old examples could give the model information that wasn't available then.

## Lesson 3: freeze the time split before training

Read `splitExamples()`. We take distinct eligible prediction times, place the first 60% in the training region, the next 20% in validation, and the last 20% in the final test. Every game uses the same boundaries.

The exact timestamps appear in `report.json`. We also remove training rows whose future label reaches the validation period and validation rows whose label reaches the test period. This is called **purging overlapping labels**. A random row split could mix observations from the same event across training and testing and exaggerate performance.

The 60/20/20 split is an initial experiment, not a universal rule. With more history we should evaluate several forward-moving time windows and reserve a final future period. Testing games never seen during training is a separate evaluation for claims about new games. This first test mainly evaluates future observations of the collected cohort.

## Lesson 4: compare the baseline and two candidates

1. **Persistence:** future players equal current players. It learns no parameters and can be difficult to beat over a short horizon.
2. **Linear:** standardized features feed Ridge regression. It learns a weighted combination of the features, with a penalty that discourages excessive weights. Scaling is fitted on training rows only.
3. **Boosted trees:** a sequence of small trees learns nonlinear relationships. We fix a small initial configuration rather than hunting for the best-looking test result. Automatic random early stopping is disabled to preserve our chronological evaluation.

All candidates train only on the training partition. Validation selects the candidate with the lowest error averaged across games. If persistence wins, the selected model has no learned predictor. That is a valid result, not a broken workflow.

## Lesson 5: read the results without claiming "accuracy"

`lesson.md` shows validation and final test errors. Lower is better.

- **MAE in players:** average absolute difference between forecast and outcome. Large games contribute large errors.
- **Macro normalized MAE:** calculate each game's total absolute error divided by its actual player volume, then average those game-level ratios. A minimum denominator of one player per example avoids division by zero. Each game contributes equally; near-zero games can still be difficult to compare.
- **Direction accuracy:** compare rising, falling, or flat activity. Changes within 2% of the current count, or one player, are classified as flat. This is a separate descriptive metric, not the model selection criterion.

For illustration, an actual count of 10,800, a baseline of 10,000, and a model forecast of 10,600 produce absolute errors of 800 and 200. These are example numbers, not our measured results.

The model is selected using validation, then evaluated on the untouched final test. The report displays test results for all candidates for learning, but do not switch to a different candidate because its test number looks better. Doing so turns the test into another validation set.

The reported relative improvement is improvement in an error metric, not a percentage of predictions "correct," and not a confidence probability. If the selected model loses to persistence on the test period, the report says so. We need more future evidence before promoting it.

## Lesson 6: repeat and then connect inference

Keep the first artifact as a dated experiment. Compare later runs across several weeks, including different weekdays and Roblox events. Reusing overlapping test periods is useful for development but does not create independent new evidence. The seven-day export deliberately limits database bandwidth; eventually we will incorporate the already-verified raw archives for longer training windows rather than repeatedly downloading all history.

Training produces `model.joblib`. **Inference** would load the selected model, calculate the same features from current observations, and forecast without seeing any future label. Load only model files produced by our own trusted workflow; joblib files can execute code, and their Python/library versions need to match.

The next product step is to save timestamped forecasts and measure their later outcomes before adding an experimental UI. Retraining and forecasting are different operations: a saved model can forecast every collection without being retrained every half hour. We have not enabled automatic training, uncertainty intervals, or live model predictions in this first experiment.

## Explain the project yourself

“We collect Roblox player counts, form examples from information available at a particular time, and learn to predict a later player count. We compare the model with a stay-the-same baseline, choose using validation, and test on later observations while excluding overlapping future labels. We track errors rather than assuming ML is better.”

References: [lagged features and chronological evaluation](https://scikit-learn.org/stable/auto_examples/applications/plot_time_series_lagged_features.html), [histogram gradient boosting](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingRegressor.html), [model persistence](https://scikit-learn.org/stable/model_persistence.html).
