from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from forecastExperiment import buildExamples, makeCandidates
from walkForwardExperiment import main, makeFolds, previousDayPredictions, selectCandidate, relativeImprovement, displayImprovement


def historyGames(days=16):
    start = datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp()
    return {str(game): [(start + index * 1800, game * (100 + index % 48)) for index in range(days * 48 + 1)] for game in range(1, 11)}


class WalkForwardTests(unittest.TestCase):
    def testFoldsHaveDisjointTestsAndNoFutureLabelsInEarlierPartitions(self):
        games = historyGames()
        examples, audit = buildExamples(games)
        folds = makeFolds(examples, games['1'][-1][0])
        seen = set()
        for fold in folds:
            splits = fold['splits']
            self.assertTrue(all(row['labelTime'] < fold['validationStart'] for row in splits['train']))
            self.assertTrue(all(fold['validationStart'] <= row['anchorTime'] and row['labelTime'] < fold['testStart'] for row in splits['validation']))
            self.assertTrue(all(fold['testStart'] <= row['anchorTime'] and row['labelTime'] < fold['testEnd'] for row in splits['test']))
            identities = {(row['gameId'], row['anchorTime']) for row in splits['test']}
            self.assertFalse(seen & identities)
            seen |= identities
            self.assertEqual(fold['testEnd'] - fold['testStart'], 2 * 86400)
        self.assertLess(len(folds[0]['splits']['train']), len(folds[-1]['splits']['train']))

    def testTooShortHistoryDoesNotSilentlyShrinkTheTests(self):
        games = historyGames(8)
        examples, audit = buildExamples(games)
        with self.assertRaisesRegex(ValueError, 'more history'):
            makeFolds(examples, games['1'][-1][0])

    def testSeasonalBaselineUsesYesterdayTargetHourAndNeverFutureRows(self):
        # Anchor 25h forecasts 26h, so yesterday's matching hour is 2h, not 1h.
        games = {'1': [(3600, 10), (7200, 20), (25 * 3600, 100), (26 * 3600, 999)]}
        rows = [{'gameId': '1', 'anchorTime': 25 * 3600, 'playersNow': 100}]
        predictions, available = previousDayPredictions(rows, games)
        self.assertEqual(predictions.tolist(), [20])
        self.assertEqual(available, [True])
        changed = {'1': games['1'][:-1] + [(26 * 3600, 999999)]}
        self.assertEqual(previousDayPredictions(rows, changed)[0].tolist(), [20])

    def testUnavailableOrStaleSeasonalObservationFallsBackToPersistence(self):
        rows = [{'gameId': '1', 'anchorTime': 25 * 3600, 'playersNow': 100}]
        predictions, available = previousDayPredictions(rows, {'1': [(3600, 10)]})
        self.assertEqual(predictions.tolist(), [100]); self.assertEqual(available, [False])

    def testSelectionUsesOnlyValidationAndPrefersBaselineOnTies(self):
        scores = {name: {'macroNormalizedMaePct': value} for name, value in [('persistence', 10), ('previousDay', 10), ('boostedTrees', 11)]}
        self.assertEqual(selectCandidate(scores), 'persistence')
        scores['boostedTrees']['macroNormalizedMaePct'] = 9
        self.assertEqual(selectCandidate(scores), 'boostedTrees')
        self.assertFalse(makeCandidates()['boostedTrees'].early_stopping)
        self.assertIsNone(relativeImprovement(0, 0))
        self.assertIn('undefined', displayImprovement(relativeImprovement(0, 0)))

    def testCompleteRunSavesThePlanBeforeTrainingAndWritesPerFoldArtifacts(self):
        games = historyGames()
        examples, eligibility = buildExamples(games)
        audit = {'uniqueRows': 7690, 'invalidRows': 0, 'games': 10, 'observedSpanHours': 384}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'observations.jsonl'
            source.write_text('{}', encoding='utf-8')
            def candidates():
                self.assertTrue((Path(directory) / 'evaluationPlan.json').is_file())
                return {'persistence': None, 'linear': None, 'boostedTrees': None}
            with patch('walkForwardExperiment.loadObservations', return_value=(games, audit)), patch('walkForwardExperiment.buildExamples', return_value=(examples, eligibility)), patch('walkForwardExperiment.makeCandidates', side_effect=candidates), patch('sys.argv', ['walkForwardExperiment.py', '--input', str(source), '--output', directory]):
                main()
            report = json.loads((Path(directory) / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual(len(report['folds']), 3)
            self.assertEqual(report['aggregate']['selected']['examples'], sum(fold['partitionSizes']['test'] for fold in report['folds']))
            self.assertEqual(report['status'], 'experimentOnly')
            self.assertTrue((Path(directory) / 'testPredictions.csv').is_file())
            self.assertTrue((Path(directory) / 'fold3Model.joblib').is_file())


if __name__ == '__main__':
    unittest.main()
