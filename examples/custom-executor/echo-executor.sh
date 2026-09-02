#!/bin/sh
# OMK custom-command exchange v1 的最小确定性实现。

python3 -c '
import json
import sys

request = json.load(sys.stdin)
prompt = request["trial"]["input"]
if not isinstance(prompt, str):
    raise TypeError("trial.input must be a string")

print(json.dumps({
    "schemaVersion": "omk.custom-command-exchange/v1",
    "resultStatus": "completed",
    "output": {
        "value": "Echo: " + prompt,
        "classification": "public",
        "mediaType": "text/plain"
    }
}))
'
