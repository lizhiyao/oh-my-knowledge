#!/usr/bin/env python3
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = SKILL_ROOT / "config.json"
PROMPT_PATH = SKILL_ROOT / "prompts" / "extract-memory.md"


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "model": "haiku",
            "max_turns": 2,
            "timeout_seconds": 90,
            "transcript_message_limit": 24,
            "transcript_char_limit": 24000,
            "min_messages": 4,
            "min_confidence": 0.45,
            "storage_root": ".aima/memroy",
            "categories": [
                "error_resolution",
                "user_preference",
                "workflow_pattern",
                "debugging_method",
                "project_convention",
                "reusable_reference",
            ],
        }


def read_hook_input() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def extract_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""


def read_transcript(transcript_path: Path, message_limit: int, char_limit: int):
    messages = []
    try:
        lines = transcript_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return messages

    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        role = entry.get("type")
        if role not in {"user", "assistant"}:
            continue

        message = entry.get("message", {})
        text = extract_text(message.get("content"))
        text = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", "", text).strip()
        if not text:
            continue
        messages.append({"role": role, "text": text})

    if message_limit > 0:
        messages = messages[-message_limit:]

    total = 0
    trimmed = []
    for message in reversed(messages):
        piece = f"{message['role'].upper()}: {message['text']}"
        total += len(piece)
        if total > char_limit:
            break
        trimmed.append(piece)
    trimmed.reverse()
    return trimmed


def build_prompt(prompt_template: str, transcript_lines, cwd: str, session_id: str) -> str:
    transcript_text = "\n\n".join(transcript_lines)
    return (
        f"{prompt_template}\n\n"
        f"Session ID: {session_id or 'unknown'}\n"
        f"Working Directory: {cwd or 'unknown'}\n\n"
        "Conversation excerpt:\n"
        f"{transcript_text}\n"
    )


def extract_json(text: str):
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def run_claude(prompt: str, cwd: str, config: dict):
    if not shutil_which("claude"):
        return None

    env = dict(os.environ)
    env["ECC_SKIP_OBSERVE"] = "1"
    env["ECC_HOOK_PROFILE"] = "minimal"
    env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts"
    env.pop("CLAUDECODE", None)

    cmd = [
        "claude",
        "--model",
        str(config.get("model", "haiku")),
        "--max-turns",
        str(config.get("max_turns", 2)),
        "--print",
    ]

    try:
        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            cwd=cwd or None,
            env=env,
            timeout=int(config.get("timeout_seconds", 90)),
            check=False,
        )
    except Exception:
        return None

    if result.returncode != 0:
        return None

    return extract_json(result.stdout)


def shutil_which(binary: str):
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / binary
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def detect_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except Exception:
        return "unknown"


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^\w\s-]", "", value)
    value = re.sub(r"[\s_-]+", "-", value)
    value = value.strip("-")
    return value[:80] or "memory"


def normalize_category(category: str, allowed_categories) -> str:
    if category in allowed_categories:
        return category
    return "workflow_pattern"


def as_list(value):
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def format_bullets(items):
    if not items:
        return "- None"
    return "\n".join(f"- {item}" for item in items)


def write_memory(result: dict, cwd: str, session_id: str, transcript_path: Path, config: dict):
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    summary = str(result.get("summary", "")).strip()
    confidence = float(result.get("confidence", 0.0) or 0.0)
    category = normalize_category(str(result.get("category", "")), config.get("categories", []))
    keywords = as_list(result.get("keywords"))
    request = str(result.get("request", "")).strip()
    investigated = as_list(result.get("investigated"))
    learned = as_list(result.get("learned"))
    completed = as_list(result.get("completed"))
    next_steps = as_list(result.get("next_steps"))
    notes = as_list(result.get("notes"))
    ip_addr = detect_local_ip()

    root = Path(cwd or os.getcwd()) / str(config.get("storage_root", ".aima/memroy"))
    target_dir = root / ip_addr / category
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{timestamp}-{slugify(summary)}.md"
    target_path = target_dir / filename

    frontmatter = [
        "---",
        f'ip: "{ip_addr}"',
        f'category: "{category}"',
        f'extracted_at: "{now.isoformat().replace("+00:00", "Z")}"',
        f'confidence: {confidence:.2f}',
        f'session_id: "{session_id or "unknown"}"',
        f'transcript_path: "{transcript_path}"',
        f'cwd: "{cwd or os.getcwd()}"',
        f'keywords: {json.dumps(keywords, ensure_ascii=False)}',
        "---",
        "",
    ]

    body = [
        f"# {summary or 'Conversation memory'}",
        "",
        "## Request",
        request or "Unknown",
        "",
        "## Investigated",
        format_bullets(investigated),
        "",
        "## Learned",
        format_bullets(learned),
        "",
        "## Completed",
        format_bullets(completed),
        "",
        "## Next Steps",
        format_bullets(next_steps),
        "",
        "## Notes",
        format_bullets(notes),
        "",
    ]

    target_path.write_text("\n".join(frontmatter + body), encoding="utf-8")


def main():
    config = load_config()
    hook_input = read_hook_input()
    transcript_path = hook_input.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    cwd = hook_input.get("cwd") or os.getcwd()
    session_id = hook_input.get("session_id") or hook_input.get("id") or ""

    if not transcript_path:
        return 0

    transcript_file = Path(transcript_path)
    if not transcript_file.exists():
        return 0

    transcript_lines = read_transcript(
        transcript_file,
        int(config.get("transcript_message_limit", 24)),
        int(config.get("transcript_char_limit", 24000)),
    )

    if len(transcript_lines) < int(config.get("min_messages", 4)):
        return 0

    try:
        prompt_template = PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return 0

    prompt = build_prompt(prompt_template, transcript_lines, cwd, session_id)
    result = run_claude(prompt, cwd, config)
    if not isinstance(result, dict):
        return 0

    if not result.get("should_store"):
        return 0

    try:
        confidence = float(result.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0

    if confidence < float(config.get("min_confidence", 0.45)):
        return 0

    write_memory(result, cwd, session_id, transcript_file, config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
