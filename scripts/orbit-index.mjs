#!/usr/bin/env node
import { RECORD_INDEX_FILE, ROOT, readAllPosts, writeRecordIndex } from './orbit-content-utils.mjs';
import path from 'node:path';

const records = readAllPosts();
writeRecordIndex(records);
process.stdout.write(`Indexed ${records.length} Orbit record(s) at ${path.relative(ROOT, RECORD_INDEX_FILE)}.\n`);
