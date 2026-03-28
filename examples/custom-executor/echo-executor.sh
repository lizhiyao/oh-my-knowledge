#!/bin/bash
# 最简单的自定义 executor 示例：echo 回显
# 用法：omk bench run --executor "./echo-executor.sh"
#
# 从 stdin 读取 JSON 输入，返回 JSON 输出

python3 -c "
import sys, json
req = json.load(sys.stdin)
print(json.dumps({'output': 'Echo: ' + req['prompt']}))
"
