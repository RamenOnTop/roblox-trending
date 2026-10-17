"""Inference only: load our pinned model and use observations available now."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import joblib
import sklearn
from forecastExperiment import featuresAt, featureNames, predictCounts, saveJson
from walkForwardExperiment import previousDayPredictions

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['input','model','manifest','output']:parser.add_argument('--'+name,required=True)
    args=parser.parse_args();manifest=json.loads(Path(args.manifest).read_text(encoding='utf-8'))
    path=Path(args.model)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest['sha256'] or manifest['featureNames']!=featureNames or manifest['sklearnVersion']!=sklearn.__version__:raise ValueError('Pinned model verification failed')
    bundle=joblib.load(path)
    if bundle['featureNames']!=featureNames or bundle['trainedThrough']!=manifest['trainedThrough']:raise ValueError('Model manifest differs from bundle')
    data=json.loads(Path(args.input).read_text(encoding='utf-8'));anchor=datetime.fromisoformat(data['generatedAt'].replace('Z','+00:00')).timestamp()
    if datetime.fromisoformat(manifest['trainedThrough'].replace('Z','+00:00')).timestamp()>=anchor:raise ValueError('Model was trained through this forecast anchor or later')
    byGame={}
    for sample in data['rawSamples']:
        stamp=datetime.fromisoformat(sample['capturedAt'].replace('Z','+00:00')).timestamp()
        if stamp<=anchor:byGame.setdefault(sample['gameId'],{})[stamp]=sample['activePlayers']
    games={gameId:sorted(values.items()) for gameId,values in byGame.items()};rows=[]
    for sample in data['currentSamples']:
        points=games.get(sample['gameId'],[]);times=[point[0] for point in points]
        if not points or points[-1][0]!=anchor:continue
        features=featuresAt(points,len(points)-1,times)
        if features is not None:rows.append({'gameId':sample['gameId'],'anchorTime':anchor,'playersNow':sample['activePlayers'],'features':features})
    predictions=predictCounts(bundle['model'],rows) if rows else []
    seasonal,available=previousDayPredictions(rows,games)
    issuedAt=datetime.now(timezone.utc).isoformat()
    if datetime.fromisoformat(issuedAt).timestamp()-anchor>600:raise ValueError('Collection is too old to issue a one-hour forecast')
    results=[{'gameId':row['gameId'],'playersNow':row['playersNow'],'predictedPlayers':float(predictions[index]),'previousDayPlayers':float(seasonal[index]) if available[index] else None} for index,row in enumerate(rows)]
    saveJson(args.output,{'issuedAt':issuedAt,'predictions':results})
    print(f'Prepared {len(results)} experimental forecasts from past/current counts.',flush=True)

if __name__=='__main__':main()
