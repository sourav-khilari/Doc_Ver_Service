// src/controllers/verifyGstController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/gst
 */
export async function verifyGstHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let { gstin, id_hash: client_hash, legal_name, trade_name, principal_place_address, state_jurisdiction, registration_date, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // normalize inputs
    if (gstin) gstin = gstin.toString().replace(/\s+/g, '').toUpperCase();
    const nameToUse = normalizeName(legal_name || trade_name || '');

    // Format check (gstin presence and regex)
    if (gstin && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) {
      checks.format_check = 1;
    } else if (!gstin) {
      checks.format_check = 0; // will rely on name fuzzy
    } else {
      checks.format_check = 0; // invalid format
    }

    // Exact lookup: prefer client-supplied id_hash, otherwise compute from gstin
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'GST', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    } else if (gstin) {
      const hash = sha256Hex(normalizeId(gstin));
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'GST', id_hash: hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // Fuzzy fallback: match by legal_name + registration_date
    if (!matchedRecord && legal_name) {
      const fuzzy = await fuzzyLookupByNameDobForEntity('GST', legal_name, registration_date);
      if (fuzzy) {
        matchedRecord = { record: fuzzy.record, match_type: 'fuzzy_name_date', score: fuzzy.score };
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Compute final confidence and decide
    const final_confidence = computeFinalConfidence(checks);
    const status = decideStatus(final_confidence);

    // Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'GST',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask PII)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        legal_name: matchedRecord.record.canonical_name || null,
        state_jurisdiction: matchedRecord.record.state_jurisdiction || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyGstHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

/**
 * Lightweight fuzzy lookup specialized for entities (uses name + registration_date)
 * Falls back to matching by canonical_name similarity among candidates.
 */
import levenshtein from 'fast-levenshtein';


async function fuzzyLookupByNameDobForEntity(docType, name, registration_date) {
  const canonical = normalizeName(name || '');
  const query = { doc_type: docType };
  if (registration_date) query.dob = new Date(registration_date); // stored in dob field for INCorp/GST seeds
  const candidates = await AuthoritativeRecord.find(query).limit(200).lean();
  if (!candidates || candidates.length === 0) return null;
  const scored = candidates.map(c => {
    const candName = c.canonical_name || '';
    const dist = levenshtein.get(canonical, normalizeName(candName));
    const maxLen = Math.max(canonical.length, candName.length, 1);
    const similarity = 1 - (dist / maxLen);
    return { record: c, similarity };
  });
  scored.sort((a,b) => b.similarity - a.similarity);
  const best = scored[0];
  if (best && best.similarity >= 0.62) return { record: best.record, score: best.similarity };
  return null;
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('gst_format_ok');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
