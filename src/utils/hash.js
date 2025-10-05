// src/utils/hash.js
import crypto from 'crypto';

export function normalizeId(id) {
  if (!id) return '';
  return id.toString().replace(/\s+/g, '').toUpperCase();
}

export function normalizeName(name) {
  if (!name) return '';
  // Unicode normalize, collapse spaces, lowercase
  return name.toString().normalize('NFKD').replace(/\p{Diacritic}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}
