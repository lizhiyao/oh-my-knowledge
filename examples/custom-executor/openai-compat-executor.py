#!/usr/bin/env python3
"""
自定义 executor 示例：通过 OpenAI 兼容 API 调用国产模型
适用于 GLM（智谱）、通义千问、Moonshot、DeepSeek 等。

用法：
  export OPENAI_API_KEY="你的 API Key"
  export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"  # 以智谱为例
  omk bench run --executor "python openai-compat-executor.py" --model glm-4-plus

也可以直接使用内置的 openai-api 执行器（无需此脚本）：
  omk bench run --executor openai-api --model glm-4-plus
"""

import json
import os
import sys
import urllib.request

def main():
    api_key = os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")

    if not api_key:
        print("Error: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    req = json.load(sys.stdin)
    model = req.get("model", "gpt-4o")
    system = req.get("system", "")
    prompt = req.get("prompt", "")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    body = json.dumps({
        "model": model,
        "messages": messages,
    }).encode()

    url = f"{base_url.rstrip('/')}/chat/completions"
    http_req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(http_req, timeout=120) as resp:
            data = json.load(resp)
            choice = data.get("choices", [{}])[0]
            output = choice.get("message", {}).get("content", "")
            usage = data.get("usage", {})
            print(json.dumps({
                "output": output,
                "inputTokens": usage.get("prompt_tokens", 0),
                "outputTokens": usage.get("completion_tokens", 0),
            }))
    except Exception as e:
        print(json.dumps({"output": ""}), file=sys.stdout)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
