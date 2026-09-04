import type { ToolDef } from '../core/registry.js';
import { tools as account } from './account.js';
import { tools as domains } from './domains.js';
import { tools as ssh } from './ssh.js';
import { tools as websites } from './websites.js';

export const allTools: ToolDef[] = [...account, ...websites, ...domains, ...ssh];
