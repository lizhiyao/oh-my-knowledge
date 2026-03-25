#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Session Memory CLI - Core Processing Script

This script handles:
1. Reading and parsing transcript
2. Calling AI (Haiku) for content extraction and classification
3. User confirmation flow
4. Saving markdown document to categorized directory
"""

import argparse
import json
import os
import sys
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

# Try to import anthropic for AI processing
try:
    from anthropic import Anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False

# Category definitions
CATEGORIES = {
    "technical": "技术方案、架构设计、代码实现",
    "troubleshooting": "问题排查、错误解决、Debug",
    "workflow": "工作流程、效率技巧、工具使用",
    "project": "项目特定知识、业务逻辑",
    "general": "通用知识、最佳实践"
}


def extract_conversation_content(transcript_path: str) -> str:
    """Extract conversation content from transcript file."""
    messages = []
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get('type') == 'user':
                        # Extract user message content
                        msg = entry.get('message', {})
                        if isinstance(msg, dict):
                            content = msg.get('content', [])
                            if isinstance(content, list):
                                for block in content:
                                    if isinstance(block, dict) and block.get('type') == 'text':
                                        text = block.get('text', '')
                                        if text:
                                            messages.append(f"User: {text[:500]}")
                            elif isinstance(content, str):
                                messages.append(f"User: {content[:500]}")
                    elif entry.get('type') == 'assistant':
                        # Extract assistant message content
                        msg = entry.get('message', {})
                        if isinstance(msg, dict):
                            content = msg.get('content', [])
                            if isinstance(content, list):
                                for block in content:
                                    if isinstance(block, dict) and block.get('type') == 'text':
                                        text = block.get('text', '')
                                        if text:
                                            # Remove system reminders
                                            text = re.sub(r'<system-reminder>[\s\S]*?</system-reminder>', '', text)
                                            messages.append(f"Assistant: {text[:500].strip()}")
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        print(f"[SessionMemory] Error reading transcript: {e}", file=sys.stderr)
        return ""

    return "\n\n".join(messages)


def compress_and_classify_with_ai(conversation: str, compression_level: str = "medium") -> Optional[Dict[str, Any]]:
    """
    Use AI (Haiku) to compress and classify conversation.

    Returns dict with:
    - title: str
    - category: str
    - core_content: str
    - context: str
    - insights: List[str]
    - related_files: List[str]
    """
    if not ANTHROPIC_AVAILABLE:
        print("[SessionMemory] Anthropic SDK not available, using fallback", file=sys.stderr)
        return fallback_compress_and_classify(conversation)

    try:
        client = Anthropic()

        # Define compression levels
        length_guidelines = {
            "short": "100-200 字",
            "medium": "300-500 字",
            "long": "500-800 字"
        }
        max_tokens = {"short": 500, "medium": 800, "long": 1200}

        prompt = f"""请分析以下对话，提炼核心内容并分类。

## 分类体系
- technical: 技术方案、架构设计、代码实现
- troubleshooting: 问题排查、错误解决、Debug
- workflow: 工作流程、效率技巧、工具使用
- project: 项目特定知识、业务逻辑
- general: 通用知识、最佳实践

## 输出格式
请严格按以下 JSON 格式输出（不要输出其他内容）：
{{
    "title": "简洁的标题，概括对话主题",
    "category": "分类（technical/troubleshooting/workflow/project/general）",
    "core_content": "核心内容摘要，{length_guidelines.get(compression_level, '300-500 字')}",
    "context": "对话背景和上下文，100-200 字",
    "insights": ["可复用的洞察 1", "可复用的洞察 2", "可复用的洞察 3"],
    "related_files": ["相关文件路径 1", "相关文件路径 2"]
}}

## 对话内容
{conversation[:15000]}  # Limit to prevent token overflow
"""

        message = client.messages.create(
            model=os.environ.get("ANTHROPIC_DEFAULT_SONNET_MODEL", os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")),
            max_tokens=max_tokens.get(compression_level, 800),
            messages=[{"role": "user", "content": prompt}]
        )

        # Check if response has content
        if not message.content or len(message.content) == 0:
            print(f"[SessionMemory] AI response has no content", file=sys.stderr)
            return None

        # Handle different content block types (TextBlock, ThinkingBlock, etc.)
        response_text = None
        for block in message.content:
            if hasattr(block, 'text'):
                response_text = block.text
                break
            elif hasattr(block, 'thinking'):
                # Some models return thinking blocks
                response_text = block.thinking
                break

        if not response_text:
            print(f"[SessionMemory] No text content in AI response. Block types: {[type(b).__name__ for b in message.content]}", file=sys.stderr)
            return None

        # Parse JSON from response
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            result = json.loads(json_match.group())
            return result
        else:
            print(f"[SessionMemory] AI didn't return JSON, using fallback method", file=sys.stderr)
            return fallback_compress_and_classify(conversation)

    except Exception as e:
        import traceback
        print(f"[SessionMemory] AI processing error: {e}", file=sys.stderr)
        print(f"[SessionMemory] Traceback: {traceback.format_exc()}", file=sys.stderr)
        return None


def fallback_compress_and_classify(conversation: str) -> Optional[Dict[str, Any]]:
    """Fallback method when AI is not available."""
    # Simple keyword-based classification
    conversation_lower = conversation.lower()

    category_scores = {
        "technical": 0,
        "troubleshooting": 0,
        "workflow": 0,
        "project": 0,
        "general": 0
    }

    # Keywords for each category
    keywords = {
        "technical": ["架构", "设计", "代码", "实现", "技术", "算法", "模块", "组件", "function", "class", "api"],
        "troubleshooting": ["错误", "异常", "bug", "修复", "解决", "排查", "debug", "error", "fix"],
        "workflow": ["流程", "效率", "工具", "脚本", "自动化", "workflow", "script", "command"],
        "project": ["项目", "业务", "需求", "功能", "产品", "业务逻辑", "feature", "requirement"],
        "general": ["最佳实践", "经验", "总结", "方法论", "pattern", "best practice"]
    }

    for category, kws in keywords.items():
        for kw in kws:
            if kw.lower() in conversation_lower:
                category_scores[category] += 1

    # Select highest scoring category
    category = max(category_scores, key=category_scores.get)

    # Generate simple summary (first 500 chars as fallback)
    lines = conversation.split('\n')
    meaningful_lines = [l for l in lines if len(l.strip()) > 20]
    core_content = '\n'.join(meaningful_lines[:10])[:500]

    # Generate title from first meaningful line
    title = meaningful_lines[0][:50].strip() if meaningful_lines else "对话记忆"

    return {
        "title": title,
        "category": category,
        "core_content": core_content,
        "context": "对话背景信息",
        "insights": ["待补充"],
        "related_files": []
    }


def sanitize_filename(title: str) -> str:
    """Sanitize title for use in filename."""
    # Remove or replace special characters
    sanitized = re.sub(r'[<>:"/\\|？*]', '', title)
    # Replace spaces with dashes
    sanitized = sanitized.replace(' ', '-')
    # Limit length
    if len(sanitized) > 50:
        sanitized = sanitized[:50]
    return sanitized


def extract_related_files(conversation: str) -> List[str]:
    """Extract file references from conversation."""
    files = []

    # Match common file patterns
    patterns = [
        r'[\w./-]+\.(ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml)',
        r'src/[\w./-]+',
        r'app/[\w./-]+',
        r'lib/[\w./-]+',
    ]

    for pattern in patterns:
        matches = re.findall(pattern, conversation)
        files.extend(matches)

    # Deduplicate and limit
    return list(set(files))[:10]


def generate_markdown(
    title: str,
    category: str,
    core_content: str,
    context: str,
    insights: List[str],
    related_files: List[str],
    session_id: str,
    machine_ip: str,
    timestamp: datetime
) -> str:
    """Generate markdown document content."""

    insights_md = ""
    if insights:
        insights_md = "\n".join([f"- {i}" for i in insights])

    files_md = ""
    if related_files:
        files_md = "\n".join([f"- `{f}`" for f in related_files])

    markdown = f"""---
timestamp: {timestamp.strftime('%Y-%m-%dT%H:%M:%S%z')}
category: {category}
session_id: {session_id}
machine_ip: {machine_ip}
---

# {title}

## 核心内容

{core_content}

## 上下文

{context}

## 技术方案/解决步骤

{insights_md if insights_md else "待补充"}

## 可复用的洞察

{insights_md if insights_md else "待补充"}

## 相关文件

{files_md if files_md else "无"}
"""
    return markdown


def save_memory(
    markdown: str,
    title: str,
    category: str,
    machine_ip: str,
    memory_path: str,
    timestamp: datetime
) -> str:
    """Save markdown document to categorized directory."""

    # Create directory structure
    base_path = Path(memory_path)
    ip_dir = base_path / machine_ip
    category_dir = ip_dir / category

    category_dir.mkdir(parents=True, exist_ok=True)

    # Generate filename
    timestamp_str = timestamp.strftime('%Y%m%d_%H%M%S')
    safe_title = sanitize_filename(title)
    filename = f"{timestamp_str}-{safe_title}.md"

    # Write file
    file_path = category_dir / filename
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    return str(file_path)


def main():
    parser = argparse.ArgumentParser(description='Session Memory CLI')
    parser.add_argument('--transcript', required=True, help='Path to transcript file')
    parser.add_argument('--machine-ip', required=True, help='Machine IP address')
    parser.add_argument('--memory-path', default='.aima/memory', help='Base memory storage path')
    parser.add_argument('--auto-confirm', default='false', help='Auto-confirm without user input')
    parser.add_argument('--compression-level', default='medium', choices=['short', 'medium', 'long'],
                        help='Compression detail level')

    args = parser.parse_args()

    # Generate session ID and timestamp
    timestamp = datetime.now()
    session_id = timestamp.strftime('%Y%m%d_%H%M%S')

    # Extract conversation
    print("[SessionMemory] Extracting conversation from transcript...", file=sys.stderr)
    conversation = extract_conversation_content(args.transcript)

    if not conversation:
        print("[SessionMemory] No conversation content found", file=sys.stderr)
        return 1

    # Compress and classify
    print("[SessionMemory] Compressing and classifying with AI...", file=sys.stderr)
    result = compress_and_classify_with_ai(conversation, args.compression_level)

    if not result:
        print("[SessionMemory] Failed to compress conversation", file=sys.stderr)
        return 1

    # Extract additional related files
    if not result.get('related_files'):
        result['related_files'] = extract_related_files(conversation)

    # Display summary and wait for confirmation
    print("\n" + "="*60, file=sys.stderr)
    print("📋 对话记忆摘要", file=sys.stderr)
    print("="*60, file=sys.stderr)
    print(f"分类：{result['category']}", file=sys.stderr)
    print(f"标题：{result['title']}", file=sys.stderr)
    print(f"\n核心内容：\n{result['core_content'][:300]}...", file=sys.stderr)
    print("="*60, file=sys.stderr)

    auto_confirm = args.auto_confirm.lower() == 'true'

    if not auto_confirm:
        print("\n是否保存此对话记忆？(回复'确认'保存，'取消'放弃): ", file=sys.stderr, end='')
        response = input().strip().lower()
        if response not in ['确认', 'confirm', 'yes', '是', '好']:
            print("[SessionMemory] User cancelled saving", file=sys.stderr)
            return 0
    else:
        print("[SessionMemory] Auto-confirm enabled, saving...", file=sys.stderr)

    # Generate markdown
    markdown = generate_markdown(
        title=result['title'],
        category=result['category'],
        core_content=result['core_content'],
        context=result.get('context', ''),
        insights=result.get('insights', []),
        related_files=result.get('related_files', []),
        session_id=session_id,
        machine_ip=args.machine_ip,
        timestamp=timestamp
    )

    # Save to file
    file_path = save_memory(
        markdown=markdown,
        title=result['title'],
        category=result['category'],
        machine_ip=args.machine_ip,
        memory_path=args.memory_path,
        timestamp=timestamp
    )

    print(f"\n✅ 已保存到：{file_path}", file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())