// 读完 stdin 后以非零退出,模拟执行器失败路径(测 mockStats 在错误路径也回填)。
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.exit(1);
