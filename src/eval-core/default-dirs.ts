import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * reports 默认根目录的**单一来源**:cli 侧 eval-runner 写、server 侧 report store 读,二者必须一致 ——
 * 否则 cli 把报告写到一处、studio 从另一处读,页面就空。放在中立的 eval-core 层,让 cli/ 与 server/
 * 两个交付层都能合法 import 同一个常量,而不必让 server 反向 import cli(那是 #242 刚清掉的分层倒挂)。
 */
export const DEFAULT_REPORTS_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

/**
 * observe-health（skill 健康度报告）默认根目录的**单一来源**:cli 侧 `omk observe <sessions>`(默认命令)写、
 * server 侧 Studio 读,二者必须一致。与 reports 同理放在中立的 eval-core 层,让 cli/ 与 server/
 * 都能 import,而不必让 server 反向 import cli。
 */
export const DEFAULT_OBSERVE_HEALTH_DIR: string = join(homedir(), '.oh-my-knowledge', 'observe-health');
