import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (!('id' in request)) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Desktop Pets test fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'add', description: 'Add two numbers locally', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] };
  else if (request.method === 'tools/call') {
    const { a, b } = request.params.arguments;
    result = { content: [{ type: 'text', text: String(a + b) }] };
  } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
