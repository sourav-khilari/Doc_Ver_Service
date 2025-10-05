// src/controllers/verifyPanController.js
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import Verification from '../models/Verification.js';
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import { normalizeId, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /verify/pan
 * expects validated body (see schemas)
 */
export async function verifyPanHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const { pan, id_hash: client_hash, name, dob, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Format check (if pan provided)
    if (pan && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) checks.format_check = 1;

    // Exact lookup path
    let matchedRecord = null;
    if (pan) {
      const norm = normalizeId(pan);
      const hash = sha256Hex(norm);
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PAN', id_hash: hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    } else if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PAN', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // Fuzzy fallback (if no exact and name given)
    if (!matchedRecord && name) {
      const fuzzy = await fuzzyLookupByNameDob('PAN', name, dob);
      if (fuzzy) {
        matchedRecord = { record: fuzzy.record, match_type: 'fuzzy_name_dob', score: fuzzy.score };
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Compute final confidence and status
    const final_confidence = computeFinalConfidence(checks);
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'PAN',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask sensitive fields)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyPanHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check) reasons.push('pan_format_ok');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
