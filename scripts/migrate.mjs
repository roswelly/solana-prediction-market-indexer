#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://spmi:spmi@localhost:5432/spmi';
const client = new Client({ connectionString: url });

await client.connect();
const sql = readFileSync(new URL('../packages/indexer/migrations/001_initial.sql', import.meta.url), 'utf8');
await client.query(sql);
await client.end();
console.log('migrations applied');
