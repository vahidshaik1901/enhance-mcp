import type { ToolDef } from '../core/registry.js';
import { tools as account } from './account.js';
import { tools as cron } from './cron.js';
import { tools as domains } from './domains.js';
import { tools as htaccess } from './htaccess.js';
import { tools as mysql } from './mysql.js';
import { tools as php } from './php.js';
import { tools as postgres } from './postgres.js';
import { tools as ssh } from './ssh.js';
import { tools as websites } from './websites.js';

export const allTools: ToolDef[] = [...account, ...websites, ...domains, ...ssh, ...mysql, ...postgres, ...php, ...htaccess, ...cron];
