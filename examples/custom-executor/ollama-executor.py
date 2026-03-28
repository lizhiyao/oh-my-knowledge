#!/usr/bin/env python3
"""
自定义 executor 示例：通过 Ollama 调用本地模型
用法：omk bench run --executor "python ollama-executor.py" --model llama3

前置要求：
  - 安装 Ollama：https://ollama.com
  - 拉取模型：ollama pull llama3
"""

import json
import sys
import urllib.request

def main():
    req = json.load(sys.stdin)
    model = req.get("model", "llama3")
    system = req.get("system", "")
    prompt = req.get("prompt", "")

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
            tokens = data.get("eval_count", 0)
            prompt_tokens = data.get("prompt_eval_count", 0)
            print(json.dumps({
                "output": output,
                "inputTokens": prompt_tokens,
                "outputTokens": tokens,
            }))
    except Exception as e:
        print(json.dumps({"output": ""}), file=sys.stdout)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
