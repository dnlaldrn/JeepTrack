import { EventEmitter } from 'node:events';
import { makePool } from './db.js';
import { startIngest } from './ingest.js';
import { log } from './log.js';

const pool = makePool();
const emitter = new EventEmitter();
startIngest({ pool, emitter });
log('server_started');
