/**
 * 副作用入口:把 7 个内置维度注册到 dimensionRegistry,把 composer rule
 * 注册到 doctor customRules。
 *
 * CLI doctor.ts 默认动态 import 本文件 → 副作用一次性完成。
 * 测试 import 各 module 的具名 export 不会触发本文件,保持 registry 干净。
 *
 * 用户自定义维度:在自己的代码里 `registerHealthDimension(spec)`,只要在
 * composer 跑之前注册即可(eg. 在 omk 配置 / plugin 入口里)。
 */

import { registerRule } from '../rules.js';
import { BUILTIN_HEALTH_DIMENSIONS } from './builtin-dimensions.js';
import { registerHealthDimension } from './dimension-registry.js';
import { makeSkillHealthComposer } from './composer.js';

for (const spec of BUILTIN_HEALTH_DIMENSIONS) {
  registerHealthDimension(spec);
}
registerRule(makeSkillHealthComposer());
