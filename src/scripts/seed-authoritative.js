// src/scripts/seed-authoritative.js
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';

async function seed(filePath, mongoUri) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) throw new Error(`Seed file not found: ${absPath}`);

  await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });

  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('Seed file must contain a JSON array');

  const ops = raw.map(item => {
    const rawId = item.raw_id || item.id_masked || item.lookup_key || '';
    const normalized = normalizeId(rawId);
    const id_hash = normalized ? sha256Hex(normalized) : undefined;
    const canonical_name = normalizeName(item.canonical_name || item.name || '');
    const filter = id_hash ? { doc_type: item.doc_type, id_hash } : { doc_type: item.doc_type, lookup_key: item.lookup_key };
    const update = {
      $set: {
        lookup_key: item.lookup_key || `${item.doc_type}-${id_hash ? id_hash.slice(0,8) : Date.now()}`,
        doc_type: item.doc_type,
        id_hash: id_hash || null,
        id_masked: item.id_masked || item.raw_id || null,
        canonical_name,
        dob: item.dob ? new Date(item.dob) : null,
        address: item.address || null,
        raw: item.raw || {},
        source: item.source || 'seed',
        updated_at: new Date()
      },
      $setOnInsert: { created_at: new Date() }
    };
    return { updateOne: { filter, update, upsert: true } };
  });

  const res = await AuthoritativeRecord.bulkWrite(ops);
  console.log('Seed complete', res);
  await mongoose.disconnect();
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('seed-authoritative.js')) {
  const fileArg = process.argv.find(a => a.startsWith('--file=')) || '--file=./src/scripts/seeds/seed_pan.json';
  const filePath = fileArg.split('=')[1];
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ayush_verifier';
  seed(filePath, MONGO_URI).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default seed;
