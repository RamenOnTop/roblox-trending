"""An educational one-hour forecast experiment. No website or database writes.

Follow the numbered stages in main(). All features use observations known at
the anchor time; future counts appear only in labels and evaluation reports.
"""
import argparse
from bisect import bisect_left, bisect_right
from collections import defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

featureNames = ["logPlayersNow", "logPlayers1hAgo", "logPlayers3hAgo",
                "logGrowthPerHour1h", "logGrowthPerHour3h", "meanLogPlayers3h",
                "stdLogPlayers3h", "peakLogPlayers3h", "lagAge1h", "lagAge3h",
                "hourSin", "hourCos", "daySin", "dayCos"]
horizonSeconds = 3600
maxGapSeconds = 45 * 60
labelToleranceSeconds = 10 * 60


def isoTime(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def loadObservations(path):
    byGame = defaultdict(dict)
    invalidRows = duplicateRows = totalRows = 0
    with Path(path).open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            totalRows += 1
            try:
                row = json.loads(line)
                gameId = row["gameId"]
                count = row["activePlayers"]
                captured = datetime.fromisoformat(row["capturedAt"].replace("Z", "+00:00"))
                if (not isinstance(gameId, str) or not gameId.isdigit() or int(gameId) <= 0
                        or isinstance(count, bool) or not isinstance(count, (int, float))
                        or not math.isfinite(count) or count < 0 or captured.tzinfo is None):
                    raise ValueError("Invalid observation")
                stamp = captured.timestamp()
            except (KeyError, TypeError, ValueError, OverflowError):
                invalidRows += 1
                continue
            if stamp in byGame[gameId]:
                if byGame[gameId][stamp] != count:
                    raise ValueError(f"Conflicting duplicate observation for game {gameId} at {isoTime(stamp)}")
                duplicateRows += 1
            byGame[gameId][stamp] = float(count)
    games = {gameId: sorted(points.items()) for gameId, points in byGame.items()}
    if not games:
        raise ValueError("No valid observations")
    gaps = spikes = fullDayGames = 0
    spans = []
    for points in games.values():
        span = (points[-1][0] - points[0][0]) / 3600
        spans.append(span)
        fullDayGames += int(span >= 24)
        for previous, current in zip(points, points[1:]):
            gaps += int(current[0] - previous[0] > maxGapSeconds)
            # Flag unusual changes for review, retain them: real events matter.
            spikes += int(previous[1] > 0 and current[1] > 0
                          and max(previous[1], current[1]) / min(previous[1], current[1]) >= 3)
    earliest = min(points[0][0] for points in games.values())
    latest = max(points[-1][0] for points in games.values())
    audit = {"inputRows": totalRows, "uniqueRows": sum(map(len, games.values())),
             "invalidRows": invalidRows, "duplicateRows": duplicateRows,
             "games": len(games), "gamesWith24h": fullDayGames,
             "medianHistoryHours": statistics.median(spans), "gapPairsOver45m": gaps,
             "spikePairsAtLeast3x": spikes, "earliest": isoTime(earliest),
             "latest": isoTime(latest), "observedSpanHours": (latest - earliest) / 3600}
    return games, audit


def featuresAt(points, index, times):
    nowTime, nowCount = points[index]
    lagIndices = [bisect_right(times, nowTime - hours * 3600) - 1 for hours in (1, 3)]
    if min(lagIndices) < 0:
        return None
    lagAges = [(nowTime - points[lagIndex][0]) / 3600 for lagIndex in lagIndices]
    if any(age - expected > maxGapSeconds / 3600 for age, expected in zip(lagAges, (1, 3))):
        return None
    window = points[lagIndices[1]:index + 1]
    if len(window) < 6 or any(right[0] - left[0] > maxGapSeconds for left, right in zip(window, window[1:])):
        return None
    logNow = math.log1p(nowCount)
    logLags = [math.log1p(points[lagIndex][1]) for lagIndex in lagIndices]
    logWindow = [math.log1p(point[1]) for point in window]
    clock = datetime.fromtimestamp(nowTime, timezone.utc)
    hourAngle = (clock.hour + clock.minute / 60) / 24 * 2 * math.pi
    dayAngle = clock.weekday() / 7 * 2 * math.pi
    return [logNow, *logLags, (logNow - logLags[0]) / lagAges[0],
            (logNow - logLags[1]) / lagAges[1], statistics.mean(logWindow),
            statistics.pstdev(logWindow), max(logWindow), *lagAges,
            math.sin(hourAngle), math.cos(hourAngle), math.sin(dayAngle), math.cos(dayAngle)]


def buildExamples(games):
    examples = []
    skippedHistory = skippedLabel = 0
    for gameId, points in games.items():
        times = [point[0] for point in points]
        for index, (stamp, count) in enumerate(points):
            features = featuresAt(points, index, times)
            if features is None:
                skippedHistory += 1
                continue
            labelIndex = bisect_left(times, stamp + horizonSeconds)
            if labelIndex >= len(times) or times[labelIndex] > stamp + horizonSeconds + labelToleranceSeconds:
                skippedLabel += 1
                continue
            labelTime, labelCount = points[labelIndex]
            examples.append({"gameId": gameId, "anchorTime": stamp, "labelTime": labelTime,
                             "playersNow": count, "actualPlayers": labelCount, "features": features,
                             "targetLogChange": math.log1p(labelCount) - math.log1p(count)})
    examples.sort(key=lambda row: (row["anchorTime"], row["gameId"]))
    return examples, {"eligibleExamples": len(examples), "skippedHistory": skippedHistory, "skippedLabel": skippedLabel}


def splitExamples(examples):
    # All games use the same cutoffs. A training label cannot cross into validation.
    times = sorted({row["anchorTime"] for row in examples})
    if len(times) < 15:
        raise ValueError("Need at least 15 distinct eligible capture times for chronological evaluation")
    validationStart = times[int(len(times) * 0.6)]
    testStart = times[int(len(times) * 0.8)]
    train = [row for row in examples if row["labelTime"] < validationStart]
    validation = [row for row in examples if row["anchorTime"] >= validationStart and row["labelTime"] < testStart]
    test = [row for row in examples if row["anchorTime"] >= testStart]
    return {"train": train, "validation": validation, "test": test}, {
        "validationStart": isoTime(validationStart), "testStart": isoTime(testStart),
        "purgedExamples": len(examples) - len(train) - len(validation) - len(test)}


def predictCounts(model, rows):
    if model is None:
        return np.array([row["playersNow"] for row in rows])
    matrix = np.array([row["features"] for row in rows])
    logNow = np.log1p([row["playersNow"] for row in rows])
    # A numerical guard, not a claimed real-world population limit.
    return np.expm1(np.clip(logNow + model.predict(matrix), 0, 30))


def measure(rows, predictions):
    perGame = defaultdict(lambda: [0.0, 0.0, 0])
    errors = []
    directionMatches = 0
    for row, prediction in zip(rows, predictions):
        error = abs(float(prediction) - row["actualPlayers"])
        errors.append(error)
        sums = perGame[row["gameId"]]
        sums[0] += error
        sums[1] += row["actualPlayers"]
        sums[2] += 1
        threshold = max(row["playersNow"] * 0.02, 1)
        def direction(value):
            difference = value - row["playersNow"]
            return 1 if difference > threshold else -1 if difference < -threshold else 0
        directionMatches += int(direction(float(prediction)) == direction(row["actualPlayers"]))
    normalized = [totalError / max(totalActual, count) for totalError, totalActual, count in perGame.values()]
    return {"examples": len(rows), "games": len(perGame), "maePlayers": statistics.mean(errors),
            "macroNormalizedMaePct": statistics.mean(normalized) * 100,
            "directionAccuracyPct": directionMatches / len(rows) * 100}


def saveJson(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=str(Path(__file__).parent / "output/observations.jsonl"))
    parser.add_argument("--output", default=str(Path(__file__).parent / "output"))
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    # 1. Audit raw source observations. This is separate from chart sparklines.
    games, audit = loadObservations(args.input)
    saveJson(output / "audit.json", audit)
    print(f"1. Audited {audit['uniqueRows']} observations across {audit['games']} games.")

    # 2. Features look backward; the label looks one hour forward (up to 10m late).
    examples, eligibility = buildExamples(games)
    saveJson(output / "eligibility.json", eligibility)
    print(f"2. Built {len(examples)} eligible one-hour examples.")

    # 3. Freeze chronological partitions before fitting or choosing a model.
    splits, boundaries = splitExamples(examples)
    if any(len(rows) < 100 or len({row['gameId'] for row in rows}) < 5 for rows in splits.values()):
        raise ValueError("Need at least 100 examples and five games in each chronological partition. Audit files remain available.")
    print("3. Split by time: " + ", ".join(f"{name}={len(rows)}" for name, rows in splits.items()))
    with (output / "examples.csv").open("w", newline="", encoding="utf-8") as destination:
        writer = csv.writer(destination)
        writer.writerow(["partition", "gameId", "anchorTime", "labelTime", "playersNow", *featureNames, "actualPlayers", "targetLogChange"])
        for name, rows in splits.items():
            for row in rows:
                writer.writerow([name, row["gameId"], isoTime(row["anchorTime"]), isoTime(row["labelTime"]),
                                 row["playersNow"], *row["features"], row["actualPlayers"], row["targetLogChange"]])

    # 4. Fit only on training rows. Disable the tree's automatic random holdout.
    trainMatrix = np.array([row["features"] for row in splits["train"]])
    trainTarget = np.array([row["targetLogChange"] for row in splits["train"]])
    candidates = {"persistence": None,
                  "linear": make_pipeline(StandardScaler(), Ridge(alpha=10)),
                  "boostedTrees": HistGradientBoostingRegressor(max_iter=120, max_leaf_nodes=15,
                      learning_rate=0.05, l2_regularization=10, early_stopping=False, random_state=42)}
    for model in candidates.values():
        if model is not None:
            model.fit(trainMatrix, trainTarget)
    validationScores = {name: measure(splits["validation"], predictCounts(model, splits["validation"]))
                        for name, model in candidates.items()}
    selectedName = min(validationScores, key=lambda name: validationScores[name]["macroNormalizedMaePct"])
    print(f"4. Validation selected {selectedName}; selection does not use the test outcomes.")

    # 5. The final test checks that frozen choice; do not reselect using this table.
    testScores = {name: measure(splits["test"], predictCounts(model, splits["test"]))
                  for name, model in candidates.items()}
    selected = candidates[selectedName]
    selectedPredictions = predictCounts(selected, splits["test"])
    baselineScore = testScores["persistence"]["macroNormalizedMaePct"]
    selectedScore = testScores[selectedName]["macroNormalizedMaePct"]
    improvement = (baselineScore - selectedScore) / baselineScore * 100 if baselineScore else None
    report = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
              "horizonMinutes": 60, "labelToleranceMinutes": 10, "maxHistoryGapMinutes": 45,
              "audit": audit, "eligibility": eligibility, "boundaries": boundaries,
              "partitionSizes": {name: len(rows) for name, rows in splits.items()},
              "featureNames": featureNames, "validation": validationScores, "selectedModel": selectedName,
              "test": testScores, "selectedTestImprovementPct": improvement,
              "status": "experimentOnly", "sklearnVersion": sklearn.__version__,
              "inputSha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
              "limitations": ["One short chronological holdout does not establish deployment readiness.",
                  "Popular chart/recommendation sample; not all Roblox games.",
                  "Seven-day raw export; older verified archives are not yet part of this experiment.",
                  "Abrupt game events and collection gaps can invalidate patterns.",
                  "Calendar features need multiple weeks of examples to learn recurring patterns."]}
    saveJson(output / "report.json", report)
    with (output / "testPredictions.csv").open("w", newline="", encoding="utf-8") as destination:
        writer = csv.writer(destination)
        writer.writerow(["gameId", "anchorTime", "labelTime", "playersNow", "actualPlayers", "baselinePlayers", "predictedPlayers", "modelName"])
        for row, prediction in zip(splits["test"], selectedPredictions):
            writer.writerow([row["gameId"], isoTime(row["anchorTime"]), isoTime(row["labelTime"]), row["playersNow"],
                             row["actualPlayers"], row["playersNow"], float(prediction), selectedName])
    # Generated locally/from our own workflow only: never load arbitrary joblib files.
    joblib.dump({"model": selected, "modelName": selectedName, "featureNames": featureNames,
                 "horizonMinutes": 60, "trainedLabelThrough": isoTime(max(row["labelTime"] for row in splits["train"])),
                 "sklearnVersion": sklearn.__version__}, output / "model.joblib")
    table = "| Method | Validation normalized error | Test normalized error | Test MAE (players) |\n| --- | ---: | ---: | ---: |\n"
    for name in candidates:
        table += f"| {name} | {validationScores[name]['macroNormalizedMaePct']:.2f}% | {testScores[name]['macroNormalizedMaePct']:.2f}% | {testScores[name]['maePlayers']:.1f} |\n"
    interpretation = (f"Selected model's test error is {improvement:.2f}% lower than persistence."
                      if improvement is not None else "The baseline has zero test error; percentage improvement is undefined.")
    if selectedName == "persistence":
        interpretation = "Validation chose the simple persistence baseline. Neither learned model earned selection."
    if improvement is not None and improvement < 0:
        interpretation += " The selected model lost to the baseline on the untouched test period."
    lesson = ("# First forecast experiment\n\nExperimental results, not a validated website prediction.\n\n"
              f"Observed {audit['observedSpanHours']:.1f} hours, {audit['games']} games, {len(examples)} eligible examples.\n\n"
              f"Validation begins {boundaries['validationStart']}; final test begins {boundaries['testStart']}. All times are UTC.\n\n"
              "Features use only past/current counts. Labels use the first observation at least one hour later, within ten minutes. "
              "Training labels crossing into validation, and validation labels crossing into test, are purged.\n\n"
              + table + f"\nValidation selected **{selectedName}**. {interpretation}\n\n"
              "Normalized error averages each game's absolute error relative to its actual player volume; lower is better. "
              "It is an error metric, not a confidence probability. Raw MAE is dominated by larger games.\n\n"
              "Open examples.csv to follow inputs and labels, and testPredictions.csv to inspect individual errors. "
              "Keep testing future periods; do not pick a different model just because it looks better in this test table.\n\n"
              "Limitations:\n\n" + "\n".join("- " + item for item in report["limitations"]) + "\n")
    (output / "lesson.md").write_text(lesson, encoding="utf-8")
    print("5. Wrote audit.json, examples.csv, report.json, testPredictions.csv, model.joblib and lesson.md.")
    print(interpretation)


if __name__ == "__main__":
    main()
