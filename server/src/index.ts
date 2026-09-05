import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bootstrap } from './bootstrap.js';
import { safe } from './core/respond.js';
import { runDoctor } from './doctor.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const command = process.argv[2] ?? 'serve';

if (command === 'doctor') {
  process.exit(await runDoctor());
} else if (command === '--version' || command === '-v') {
  console.error(VERSION);
} else if (command === 'serve') {
  try {
    const { ctx, tools } = await bootstrap();
    console.error(`enhance-mcp ${VERSION}: ${tools.length} tools, org ${ctx.client.orgName ? safe(ctx.client.orgName) : 'unselected'}, credential ${ctx.client.authMode}${ctx.config.readOnly ? ', read-only' : ''}`);
    serveStdio(() => createServer(ctx, tools));
  } catch (e) {
    console.error(`enhance-mcp: startup failed: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  console.error('usage: enhance-mcp [serve|doctor|--version]');
  process.exit(2);
}
