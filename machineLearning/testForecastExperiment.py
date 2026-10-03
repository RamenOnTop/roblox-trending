import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from forecastExperiment import buildExamples, featuresAt, loadObservations, main, measure, splitExamples


def samplePoints(size=60):
    return [(1790985600 + index * 1800, 100 + index * 3) for index in range(size)]


class ForecastTests(unittest.TestCase):
    def testCompleteExperimentWritesFrozenSelectionAndReport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.jsonl"
            rows = []
            for game in range(1, 11):
                for stamp, count in samplePoints(96):
                    rows.append({"gameId": str(game), "capturedAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat(), "activePlayers": count * game})
            path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            with patch("sys.argv", ["forecastExperiment.py", "--input", str(path), "--output", directory]):
                main()
            report = json.loads((Path(directory) / "report.json").read_text(encoding="utf-8"))
            expected = min(report["validation"], key=lambda name: report["validation"][name]["macroNormalizedMaePct"])
            self.assertEqual(report["selectedModel"], expected)
            self.assertEqual(report["status"], "experimentOnly")
            self.assertEqual(len(report["inputSha256"]), 64)
            for name in ["examples.csv", "testPredictions.csv", "model.joblib", "lesson.md"]:
                self.assertTrue((Path(directory) / name).is_file())

    def testFutureSpikeCannotChangeFeatures(self):
        points = samplePoints()
        times = [stamp for stamp, count in points]
        original = featuresAt(points, 12, times)
        changed = points[:13] + [(stamp, count * 1000) for stamp, count in points[13:]]
        self.assertEqual(original, featuresAt(changed, 12, times))
        self.assertIsNotNone(original)

    def testLabelsNeedObservedFutureAndRespectHorizon(self):
        examples, audit = buildExamples({"1": samplePoints()})
        self.assertTrue(examples)
        self.assertGreater(audit["skippedLabel"], 0)
        for row in examples:
            self.assertGreaterEqual(row["labelTime"] - row["anchorTime"], 3600)
            self.assertLessEqual(row["labelTime"] - row["anchorTime"], 4200)

    def testMissingLabelIsNotInterpolated(self):
        points = samplePoints(15)
        # At anchor 10 the one-hour label would be point 12, but it was missed.
        points = [point for index, point in enumerate(points) if index != 12]
        examples, audit = buildExamples({"1": points})
        self.assertFalse(any(row["anchorTime"] == samplePoints()[10][0] for row in examples))

    def testLargeHistoricalGapBlocksFeatures(self):
        points = samplePoints()
        points = points[:8] + points[11:]
        index = 10
        self.assertIsNone(featuresAt(points, index, [stamp for stamp, count in points]))

    def testAllGamesShareTimeCutoffsAndLabelsArePurged(self):
        examples, audit = buildExamples({"1": samplePoints(), "2": samplePoints()})
        splits, boundaries = splitExamples(examples)
        validationStart = min(row["anchorTime"] for row in splits["validation"])
        testStart = min(row["anchorTime"] for row in splits["test"])
        self.assertTrue(all(row["labelTime"] < validationStart for row in splits["train"]))
        self.assertTrue(all(row["labelTime"] < testStart for row in splits["validation"]))
        self.assertGreater(boundaries["purgedExamples"], 0)
        for rows in splits.values():
            self.assertEqual({row["gameId"] for row in rows}, {"1", "2"})

    def testAuditDeduplicatesAndRetainsRealZero(self):
        row = {"gameId": "1", "capturedAt": "2026-10-03T12:00:00Z", "activePlayers": 0}
        bad = {**row, "gameId": "2", "activePlayers": -1}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.jsonl"
            path.write_text("\n".join(json.dumps(item) for item in [row, row, bad]), encoding="utf-8")
            games, audit = loadObservations(path)
            self.assertEqual(audit["uniqueRows"], 1)
            self.assertEqual(audit["invalidRows"], 1)
            self.assertEqual(audit["duplicateRows"], 1)
            self.assertEqual(games["1"][0][1], 0)
            path.write_text("\n".join(json.dumps(item) for item in [row, {**row, "activePlayers": 100}]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
                loadObservations(path)

    def testMetricsWeightGamesSeparately(self):
        rows = [{"gameId": "1", "playersNow": 100, "actualPlayers": 100},
                {"gameId": "2", "playersNow": 100000, "actualPlayers": 100000}]
        metrics = measure(rows, [90, 90000])
        self.assertEqual(metrics["macroNormalizedMaePct"], 10)
        self.assertEqual(metrics["maePlayers"], 5005)


if __name__ == "__main__":
    unittest.main()
