const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(JSON.stringify({ output: `fixture: ${input.prompt}` }));
