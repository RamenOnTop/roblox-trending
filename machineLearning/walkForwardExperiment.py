"""Expanding-history evaluation using verified archives and recent observations.

Three disjoint two-day tests follow separate one-day validation periods. All
splits are fixed before fitting. No live forecasts or database writes.
"""
import argparse
from bisect import bisect_right
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import statistics

import joblib
import numpy as np
import sklearn

from forecastExperiment import (buildExamples, featureNames, horizonSeconds, isoTime,
    loadObservations, makeCandidates, maxGapSeconds, measure, predictCounts, saveJson)

daySeconds = 86400


def makeFolds(examples, latestObserved, foldCount=3, testDays=2, validationDays=1, minTrainDays=5):
    if not examples or min(foldCount, testDays, validationDays, minTrainDays) < 1:
        raise ValueError("Invalid walk-forward configuration or empty examples")
    # Exclude today's partial UTC day from the tests so their lengths are comparable.
    end = int(latestObserved // daySeconds) * daySeconds
    earliest = min(row["anchorTime"] for row in examples)
    folds = []
    for index in range(foldCount):
        testEnd = end - (foldCount - 1 - index) * testDays * daySeconds
        testStart = testEnd - testDays * daySeconds
        validationStart = testStart - validationDays * daySeconds
        if validationStart - earliest < minTrainDays * daySeconds:
            raise ValueError("Need more history for the fixed walk-forward windows; refusing shorter tests")
        splits = {
            "train": [row for row in examples if row["labelTime"] < validationStart],
            "validation": [row for row in examples if validationStart <= row["anchorTime"] and row["labelTime"] < testStart],
            "test": [row for row in examples if testStart <= row["anchorTime"] and row["labelTime"] < testEnd],
        }
        if any(len(rows) < 100 or len({row["gameId"] for row in rows}) < 5 for rows in splits.values()):
            raise ValueError("Each fold partition needs at least 100 examples and five games")
        purged = sum(row["anchorTime"] < validationStart <= row["labelTime"] or
                     validationStart <= row["anchorTime"] < testStart <= row["labelTime"] or
                     testStart <= row["anchorTime"] < testEnd <= row["labelTime"] for row in examples)
        folds.append({"fold": index + 1, "validationStart": validationStart,
                      "testStart": testStart, "testEnd": testEnd, "purgedExamples": purged,
                      "splits": splits})
    return folds


def previousDayPredictions(rows, games):
    """Yesterday's observed count for the FUTURE target hour, with a safe fallback.

    At 11:00 predicting 12:00, look near yesterday 12:00 (23 hours before
    the anchor), never at a future label or a fabricated/interpolated value.
    """
    times = {gameId: [stamp for stamp, value in points] for gameId, points in games.items()}
    predictions = []
    available = []
    for row in rows:
        target = row["anchorTime"] + horizonSeconds - daySeconds
        points = games.get(row["gameId"], [])
        index = bisect_right(times.get(row["gameId"], []), target) - 1
        found = index >= 0 and target - points[index][0] <= maxGapSeconds
        predictions.append(points[index][1] if found else row["playersNow"])
        available.append(bool(found))
    return np.array(predictions), available


def selectCandidate(validationScores):
    return min(validationScores, key=lambda name: validationScores[name]["macroNormalizedMaePct"])


def relativeImprovement(baseline, candidate):
    return (baseline - candidate) / baseline * 100 if baseline else None


def displayImprovement(value):
    return f"{value:.2f}%" if value is not None else "undefined (zero baseline error)"


def evaluateFolds(games, folds, output):
    reports = []
    aggregateRows = []
    aggregatePredictions = {name: [] for name in ["persistence", "previousDay", "linear", "boostedTrees", "selected"]}
    with (output / "testPredictions.csv").open("w", newline="", encoding="utf-8") as destination:
        writer = csv.writer(destination)
        writer.writerow(["fold", "gameId", "anchorTime", "labelTime", "playersNow", "actualPlayers",
                         "persistence", "previousDay", "previousDayAvailable", "linear", "boostedTrees",
                         "selectedModel", "selectedPrediction"])
        for fold in folds:
            splits = fold["splits"]
            candidates = makeCandidates()
            matrix = np.array([row["features"] for row in splits["train"]])
            target = np.array([row["targetLogChange"] for row in splits["train"]])
            for model in candidates.values():
                if model is not None:
                    model.fit(matrix, target)
            validationPredictions = {name: predictCounts(model, splits["validation"]) for name, model in candidates.items()}
            validationPredictions["previousDay"], validationAvailable = previousDayPredictions(splits["validation"], games)
            # Prefer a simple baseline in an exact validation tie.
            order = ["persistence", "previousDay", "linear", "boostedTrees"]
            validationScores = {name: measure(splits["validation"], validationPredictions[name]) for name in order}
            selectedName = selectCandidate(validationScores)
            selectedBaseline = selectCandidate({name: validationScores[name] for name in ["persistence", "previousDay"]})
            # Selection is frozen before computing any test scores.
            predictions = {name: predictCounts(model, splits["test"]) for name, model in candidates.items()}
            predictions["previousDay"], testAvailable = previousDayPredictions(splits["test"], games)
            testScores = {name: measure(splits["test"], predictions[name]) for name in order}
            aggregateRows.extend(splits["test"])
            for name in order:
                aggregatePredictions[name].extend(predictions[name])
            aggregatePredictions["selected"].extend(predictions[selectedName])
            for index, row in enumerate(splits["test"]):
                writer.writerow([fold["fold"], row["gameId"], isoTime(row["anchorTime"]), isoTime(row["labelTime"]),
                    row["playersNow"], row["actualPlayers"], predictions["persistence"][index],
                    predictions["previousDay"][index], testAvailable[index], predictions["linear"][index],
                    predictions["boostedTrees"][index], selectedName, predictions[selectedName][index]])
            report = {"fold": fold["fold"], "validationStart": isoTime(fold["validationStart"]),
                      "testStart": isoTime(fold["testStart"]), "testEnd": isoTime(fold["testEnd"]),
                      "trainedLabelThrough": isoTime(max(row["labelTime"] for row in splits["train"])),
                      "partitionSizes": {name: len(rows) for name, rows in splits.items()},
                      "purgedExamples": fold["purgedExamples"], "validation": validationScores,
                      "selectedModel": selectedName, "selectedBaseline": selectedBaseline, "test": testScores,
                      "previousDayCoverage": {"validationPct": statistics.mean(validationAvailable) * 100,
                                              "testPct": statistics.mean(testAvailable) * 100},
                      "selectedTestImprovementPct": relativeImprovement(testScores["persistence"]["macroNormalizedMaePct"], testScores[selectedName]["macroNormalizedMaePct"]),
                      "selectedVsChosenBaselinePct": relativeImprovement(testScores[selectedBaseline]["macroNormalizedMaePct"], testScores[selectedName]["macroNormalizedMaePct"])}
            reports.append(report)
            # Historical fold models are reproducibility artifacts, not live forecasts.
            joblib.dump({"model": candidates.get(selectedName), "modelName": selectedName, "featureNames": featureNames,
                         "fold": fold["fold"], "trainedLabelThrough": report["trainedLabelThrough"],
                         "sklearnVersion": sklearn.__version__, "status": "historicalExperimentOnly"},
                        output / f"fold{fold['fold']}Model.joblib")
            print(f"Fold {fold['fold']}: selected {selectedName}; test improvement vs persistence {displayImprovement(report['selectedTestImprovementPct'])}", flush=True)
    aggregate = {name: measure(aggregateRows, predictions) for name, predictions in aggregatePredictions.items()}
    return reports, aggregate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=str(Path(__file__).parent / "output/observations.jsonl"))
    parser.add_argument("--output", default=str(Path(__file__).parent / "output"))
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    games, audit = loadObservations(args.input)
    if audit["invalidRows"]:
        raise ValueError("Combined verified history contains invalid observations")
    examples, eligibility = buildExamples(games)
    latest = max(points[-1][0] for points in games.values())
    folds = makeFolds(examples, latest)
    saveJson(output / "audit.json", audit)
    saveJson(output / "eligibility.json", eligibility)
    # Save reproducible boundaries before fitting any candidate.
    saveJson(output / "evaluationPlan.json", {"foldCount": 3, "testDays": 2, "validationDays": 1,
        "minTrainDays": 5, "training": "expanding", "features": featureNames,
        "folds": [{key: isoTime(value) if key in ["validationStart", "testStart", "testEnd"] else value
                   for key, value in fold.items() if key != "splits"} for fold in folds]})
    print(f"Audited {audit['uniqueRows']} observations; built {len(examples)} eligible examples.", flush=True)
    reports, aggregate = evaluateFolds(games, folds, output)
    improvement = relativeImprovement(aggregate["persistence"]["macroNormalizedMaePct"], aggregate["selected"]["macroNormalizedMaePct"])
    wins = sum(report["selectedTestImprovementPct"] is not None and report["selectedTestImprovementPct"] > 0 for report in reports)
    baselineWins = sum(report["selectedVsChosenBaselinePct"] is not None and report["selectedVsChosenBaselinePct"] > 0 for report in reports)
    report = {"schemaVersion": 2, "createdAt": datetime.now(timezone.utc).isoformat(), "status": "experimentOnly", "evaluation": "expandingWalkForward",
        "inputSha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(), "sklearnVersion": sklearn.__version__,
        "horizonMinutes": 60, "labelToleranceMinutes": 10, "audit": audit, "eligibility": eligibility,
        "folds": reports, "aggregate": aggregate, "selectedTestImprovementPct": improvement,
        "winsVsPersistence": wins, "winsVsValidationChosenBaseline": baselineWins,
        "selectionCounts": dict(Counter(fold["selectedModel"] for fold in reports)),
        "limitations": ["Retrospective development evaluation; some dates were inspected in prior experiments, not a new sealed final test.",
            "Tests are disjoint, but training expands and nearby game observations are correlated.",
            "Only tracked games are represented; no unseen-game generalization claim.",
            "Previous-day baseline falls back to persistence when a historical observation is unavailable.",
            "About two weeks cannot establish stable weekday, event or long-term behavior.",
            "No live forecasts, calibrated intervals, or deployment-readiness claim."]}
    saveJson(output / "report.json", report)
    lesson = "# Archived-history walk-forward experiment\n\nAll table boundaries are UTC. Lower normalized error is better; it is not accuracy or confidence.\n\n"
    lesson += f"Used {audit['uniqueRows']:,} observations across {audit['observedSpanHours'] / 24:.1f} days and {audit['games']:,} games.\n\n"
    lesson += "Each round trains on earlier history, chooses a method using the next day, then tests on the following two days. Later rounds may train on earlier rounds' outcomes once those outcomes are in the past.\n\n"
    lesson += "| Round | Test start | Test end (exclusive) | Validation choice | Persistence error | Yesterday error | Selected error | Error reduction vs persistence |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: |\n"
    for fold in reports:
        lesson += f"| {fold['fold']} | {fold['testStart']} | {fold['testEnd']} | {fold['selectedModel']} | {fold['test']['persistence']['macroNormalizedMaePct']:.2f}% | {fold['test']['previousDay']['macroNormalizedMaePct']:.2f}% | {fold['test'][fold['selectedModel']]['macroNormalizedMaePct']:.2f}% | {displayImprovement(fold['selectedTestImprovementPct'])} |\n"
    lesson += f"\nThe validation-selected strategy beat persistence in {wins}/3 rounds and the validation-chosen simple baseline in {baselineWins}/3 rounds.\n\n"
    lesson += "Aggregate errors recompute each game's error over all disjoint test rows; they are not a simple average of the round percentages.\n\n"
    lesson += "| Method | Aggregate normalized error | Average absolute miss, players |\n| --- | ---: | ---: |\n"
    for name, metrics in aggregate.items():
        lesson += f"| {name} | {metrics['macroNormalizedMaePct']:.2f}% | {metrics['maePlayers']:.1f} |\n"
    lesson += "\n'selected' is the method chosen separately on each round's validation data, not the best method picked after seeing tests. These historical fold models are not deployed.\n\n"
    lesson += "Yesterday's baseline predicts the target hour using an actual observation from the prior day, at most 45 minutes older than the matching time; unavailable history falls back to the current count. Coverage is recorded per round.\n\n"
    lesson += "Limitations:\n\n" + "\n".join("- " + item for item in report["limitations"]) + "\n"
    (output / "lesson.md").write_text(lesson, encoding="utf-8")
    print("Saved report.json, evaluationPlan.json, testPredictions.csv, historical fold models and lesson.md.", flush=True)


if __name__ == "__main__":
    main()
