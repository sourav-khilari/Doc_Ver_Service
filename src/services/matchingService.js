// src/services/matchingService.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';

/**
 * Exact lookup by identifier (rawId is the unhashed id, e.g., PAN)
 * returns the record or null
 */
export async function exactLookupById(docType, rawId) {
  if (!rawId) return null;
  const normalized = normalizeId(rawId);
  const id_hash = sha256Hex(normalized);
  const rec = await AuthoritativeRecord.findOne({ doc_type: docType, id_hash }).lean();
  if (!rec) return null;
  return { record: rec, id_hash };
}

/**
 * Fuzzy lookup by name + dob (dob optional). Returns {record, score} or null.
 * Uses simple levenshtein-based similarity; tuned threshold.
 */
export async function fuzzyLookupByNameDob(docType, name, dob) {
  if (!name) return null;
  const canonical = normalizeName(name);

  const query = { doc_type: docType };
  if (dob) query.dob = new Date(dob);

  // Light filter: if dob present, this reduces candidates drastically
  const candidates = await AuthoritativeRecord.find(query).limit(200).lean();
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates.map(c => {
    const candName = c.canonical_name || '';
    const dist = levenshtein.get(canonical, candName);
    const maxLen = Math.max(canonical.length, candName.length, 1);
    const similarity = 1 - (dist / maxLen); // 0..1
    return { record: c, similarity };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  // threshold: require >= 0.65 similarity to consider a candidate
  if (best && best.similarity >= 0.65) {
    return { record: best.record, score: best.similarity };
  }
  return null;
}
