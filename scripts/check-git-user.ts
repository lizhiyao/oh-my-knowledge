#!/usr/bin/env npx tsx
/**
 * 检查当前项目的 git username 和 useremail 是否符合规范
 * 要求：以 "sansaxu" 开头
 */

import { execSync } from 'node:child_process';

function getGitConfig(key: string): string | null {
  try {
    return execSync(`git config user.${key}`, { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function main(): void {
  const userName = getGitConfig('name');
  const userEmail = getGitConfig('email');

  console.log('=== Git 用户配置检查 ===\n');
  console.log(`user.name:  ${userName ?? '(未设置)'}`);
  console.log(`user.email: ${userEmail ?? '(未设置)'}\n`);

  const nameValid = userName?.startsWith('sansaxu') ?? false;
  const emailValid = userEmail?.startsWith('sansaxu') ?? false;

  if (nameValid && emailValid) {
    console.log('✅ 检查通过：username 和 useremail 都以 sansaxu 开头');
    process.exit(0);
  } else {
    console.log('❌ 检查失败：');
    if (!nameValid) {
      console.log(`   - user.name "${userName}" 不是以 "sansaxu" 开头`);
    }
    if (!emailValid) {
      console.log(`   - user.email "${userEmail}" 不是以 "sansaxu" 开头`);
    }
    process.exit(1);
  }
}

main();