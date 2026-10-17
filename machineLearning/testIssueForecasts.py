from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import joblib
import sklearn
from sklearn.dummy import DummyRegressor
from forecastExperiment import featureNames
from issueForecasts import main

class FixedClock(datetime):
    @classmethod
    def now(cls,tz=None):
        return cls(2026,10,17,12,2,tzinfo=timezone.utc)

class IssueTests(unittest.TestCase):
    def testInferenceUsesOnlyObservedPastAndRecordsActualIssueTime(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);predictor=DummyRegressor(strategy='constant',constant=0).fit([[0]*14],[0])
            trained='2026-10-16T00:00:00+00:00';path=root/'model.joblib'
            joblib.dump({'model':predictor,'featureNames':featureNames,'trainedThrough':trained},path)
            manifest={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'featureNames':featureNames,'sklearnVersion':sklearn.__version__,'trainedThrough':trained}
            (root/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            samples=[{'gameId':'1','capturedAt':f'2026-10-17T{hour:02d}:{minute:02d}:00+00:00','activePlayers':100} for hour,minute in [(9,0),(9,30),(10,0),(10,30),(11,0),(11,30),(12,0)]]
            data={'generatedAt':'2026-10-17T12:00:00+00:00','currentSamples':[samples[-1]],'rawSamples':samples+[{'gameId':'1','capturedAt':'2026-10-17T13:00:00Z','activePlayers':99999}]}
            (root/'input.json').write_text(json.dumps(data),encoding='utf-8')
            argv=['issueForecasts.py','--input',str(root/'input.json'),'--model',str(path),'--manifest',str(root/'manifest.json'),'--output',str(root/'predictions.json')]
            with patch('sys.argv',argv),patch('issueForecasts.datetime',FixedClock):main()
            result=json.loads((root/'predictions.json').read_text(encoding='utf-8'))
            self.assertEqual(result['issuedAt'],'2026-10-17T12:02:00+00:00')
            self.assertAlmostEqual(result['predictions'][0]['predictedPlayers'],100)
            manifest['sha256']='0'*64;(root/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            with patch('sys.argv',argv),patch('issueForecasts.datetime',FixedClock),self.assertRaisesRegex(ValueError,'verification'):main()

if __name__=='__main__':unittest.main()
