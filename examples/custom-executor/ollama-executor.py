#!/usr/bin/env python3
"""OMK custom-command exchange v1 adapter for a local Ollama model."""

import json
import sys
import urllib.request

SCHEMA_VERSION = "omk.custom-command-exchange/v1"


def artifact(request):
    target = request.get("trial", {}).get("targetConfig", {})
    return target.get("behavior", {}).get("artifact", {})


def artifact_instructions(request):
    resource_id = artifact(request).get("resourceId")
    if not resource_id:
        return ""
    for resource in request.get("resources", []):
        if resource.get("resourceId") == resource_id:
            path = resource.get("snapshotPath")
            if path:
                with open(path, encoding="utf-8") as source:
                    return source.read()
    return ""


def completed(output, classification):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "resultStatus": "completed",
        "output": {
            "value": output,
            "classification": classification,
            "mediaType": "text/plain",
        },
    }


def failed():
    return {
        "schemaVersion": SCHEMA_VERSION,
        "resultStatus": "failed",
        "error": {
            "code": "ollama-request-failed",
            "stage": "execution",
        },
    }


def main():
    req = json.load(sys.stdin)
    trial = req.get("trial", {})
    target = trial.get("targetConfig", {})
    model = target.get("runtime", {}).get("model", "llama3")
    prompt = trial.get("input", "")
    if not isinstance(prompt, str):
        prompt = json.dumps(prompt, ensure_ascii=False)
    system = artifact_instructions(req)
    classification = artifact(req).get("classification", "public")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode()
    http_req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(http_req, timeout=120) as resp:
            data = json.load(resp)
            output = data.get("message", {}).get("content", "")
            print(json.dumps(completed(output, classification)))
    except Exception as e:
        print(json.dumps(failed()), file=sys.stdout)
        print(f"Error: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
