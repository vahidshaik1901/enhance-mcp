import type { ToolDef } from '../core/registry.js';
import { tools as account } from './account.js';
import { tools as apps } from './apps.js';
import { tools as cron } from './cron.js';
import { tools as domains } from './domains.js';
import { tools as files } from './files.js';
import { tools as htaccess } from './htaccess.js';
import { tools as mysql } from './mysql.js';
import { tools as node } from './node.js';
import { tools as php } from './php.js';
import { tools as postgres } from './postgres.js';
import { tools as ssh } from './ssh.js';
import { tools as websites } from './websites.js';

export const allTools: ToolDef[] = [...account, ...websites, ...domains, ...ssh, ...files, ...mysql, ...postgres, ...php, ...htaccess, ...cron, ...node, ...apps];
