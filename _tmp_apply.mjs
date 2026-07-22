import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const sql = fs.readFileSync(process.argv[2], 'utf8');
const res = await fetch('https://api.supabase.com/v1/projects/rfsvmhcqeiyrxivbmpel/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
console.log('status:', res.status, (await res.text()).slice(0, 300));
