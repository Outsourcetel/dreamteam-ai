#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_ANON_KEY not set');
  console.error('Set them in .env.local or .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getMigrationNumber(filename) {
  const match = filename.match(/^(\d+)_/);
  return match ? parseInt(match[1], 10) : null;
}

async function getMigrationsApplied() {
  const { data, error } = await supabase
    .from('_supabase_migrations')
    .select('name')
    .order('name', { ascending: true });

  if (error) {
    console.warn('⚠️  Could not read migration history (expected on first run)');
    return new Set();
  }

  return new Set(data.map(m => m.name));
}

async function applyMigration(filename, content) {
  console.log(`\n🔄 Applying ${filename}...`);

  try {
    const { error } = await supabase.rpc('exec_sql', { sql: content });

    if (error) {
      console.error(`❌ Migration failed:`, error.message);
      return false;
    }

    // Record migration
    const { error: recordError } = await supabase
      .from('_supabase_migrations')
      .insert([{ name: filename, executed_at: new Date().toISOString() }]);

    if (recordError && !recordError.message.includes('duplicate')) {
      console.warn(`⚠️  Could not record migration (non-critical):`, recordError.message);
    }

    console.log(`✅ ${filename} applied successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Error applying migration:`, err.message);
    return false;
  }
}

async function main() {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const appliedMigrations = await getMigrationsApplied();
  const pending = files.filter(f => !appliedMigrations.has(f));

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  MIGRATION STATUS`);
  console.log(`════════════════════════════════════════════`);
  console.log(`Total migrations: ${files.length}`);
  console.log(`Applied: ${appliedMigrations.size}`);
  console.log(`Pending: ${pending.length}`);

  if (pending.length === 0) {
    console.log(`\n✅ All migrations applied!`);
    return;
  }

  console.log(`\n📋 Pending migrations:`);
  pending.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f}`);
  });

  if (process.argv.includes('--skip-confirm')) {
    console.log(`\n✅ Applying all pending migrations...`);
    for (const file of pending) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const success = await applyMigration(file, content);
      if (!success) {
        console.error(`\n❌ Stopped at ${file}`);
        process.exit(1);
      }
    }
    console.log(`\n✅ All pending migrations applied!`);
  } else {
    console.log(`\nRun with --skip-confirm to apply all pending migrations`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
