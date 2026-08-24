#!/bin/sh
# 全量评测夹具会为每个 task 启动一次本脚本。协议解析和 prompt 透传已有独立单测，
# 这里用 shell 内建命令返回固定结果，避免每个 task 再派生 Python 进程。
IFS= read -r _request
printf '%s\n' '{"output":"fixture output"}'
