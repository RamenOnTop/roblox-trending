"""Freeze an experimental model from our verified, evaluated source dataset."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import sklearn
from forecastExperiment import buildExamples, featureNames, isoTime, loadObservations, makeCandidates, saveJson

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True);parser.add_argument('--report',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    source=Path(args.input);report=json.loads(Path(args.report).read_text(encoding='utf-8'))
    digest=hashlib.sha256(source.read_bytes()).hexdigest()
    if report.get('inputSha256')!=digest or report.get('winsVsPersistence')!=3 or any(fold['selectedModel']!='boostedTrees' or fold['selectedVsChosenBaselinePct']<=0 for fold in report['folds']):
        raise ValueError('Source or historical evaluation does not match experimental model setup')
    games,audit=loadObservations(source);rows,eligibility=buildExamples(games)
    if audit['invalidRows'] or not rows:raise ValueError('Invalid model source')
    model=makeCandidates()['boostedTrees'];model.fit(np.array([row['features'] for row in rows]),np.array([row['targetLogChange'] for row in rows]))
    createdAt=datetime.now(timezone.utc).isoformat();trainedThrough=isoTime(max(row['labelTime'] for row in rows))
    bundle={'model':model,'featureNames':featureNames,'sklearnVersion':sklearn.__version__,'trainedThrough':trainedThrough}
    target=output/'experimentalModel.joblib';joblib.dump(bundle,target)
    modelDigest=hashlib.sha256(target.read_bytes()).hexdigest();modelFile=f'model-{modelDigest}.joblib';target.rename(output/modelFile)
    manifest={'schemaVersion':1,'modelVersion':f"trees-{modelDigest[:12]}",'modelFile':modelFile,'sha256':modelDigest,'createdAt':createdAt,'trainedThrough':trainedThrough,'trainingExamples':len(rows),'sklearnVersion':sklearn.__version__,'featureNames':featureNames,'horizonMinutes':60,'status':'experimental','sourceSha256':digest}
    saveJson(output/'modelManifest.json',manifest);print(json.dumps(manifest),flush=True)

if __name__=='__main__':main()
