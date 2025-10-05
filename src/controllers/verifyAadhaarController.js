// src/controllers/verifyAadhaarController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/aadhaar
 * expects validated body (see verifyAadhaarSchema)
 */
export async function verifyAadhaarHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const { aadhaar, id_hash: client_hash, aadhaar_last4, name, dob, pincode, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Format checks:
    if (aadhaar && /^[0-9]{12}$/.test(aadhaar)) checks.format_check = 1;
    else if (aadhaar_last4 && /^[0-9]{4}$/.test(aadhaar_last4)) checks.format_check = 0.7; // partial

    // Exact lookup path: prefer client-supplied id_hash; if aadhaar provided compute hash here (only if allowed)
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'AADHAAR', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    } else if (aadhaar) {
      // WARNING: only do this if your app policy permits receiving full Aadhaar.
      const normalized = normalizeId(aadhaar);
      const hash = sha256Hex(normalized);
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'AADHAAR', id_hash: hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // If not found and last4 available, try to match candidates by last4 + name + dob/pincode
    if (!matchedRecord && (aadhaar_last4 || name)) {
      // Quick filter: lookup records with matching last4 in id_masked or matching dob
      const query = { doc_type: 'AADHAAR' };
      if (dob) query.dob = new Date(dob);
      // fetch a candidate set
      const candidates = await AuthoritativeRecord.find(query).limit(200).lean();
      // filter by last4 if provided
      let filtered = candidates;
      if (aadhaar_last4) {
        filtered = candidates.filter(c => {
          if (!c.id_masked) return false;
          return c.id_masked.endsWith(aadhaar_last4) || (c.id_masked.includes(aadhaar_last4));
        });
      }
      // if filtered empty, fall back to all candidates
      const effectiveCandidates = (filtered && filtered.length) ? filtered : candidates;

      // use fuzzy matching on name (reuse levenshtein via matchingService logic)
      let best = null;
      for (const c of effectiveCandidates) {
        const cand = await fuzzyScoreCandidate(c, name);
        if (!best || cand.score > best.score) best = cand;
      }
      if (best && best.score >= 0.65) {
        matchedRecord = { record: best.record, match_type: 'fuzzy_name_dob', score: best.score };
        checks.db_match_score = best.score;
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
      doc_type: 'AADHAAR',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Shape response; never include full Aadhaar
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked,
        pincode: matchedRecord.record.pincode || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyAadhaarHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

// helper: simple fuzzy score using name similarity (reuse fast-levenshtein style)
import levenshtein from 'fast-levenshtein';
import { normalizeName } from '../utils/hash.js';

async function fuzzyScoreCandidate(candidate, name) {
  const candName = candidate.canonical_name || (candidate.raw && candidate.raw.name) || '';
  const canonical = normalizeName(name || '');
  const candCanon = normalizeName(candName || '');
  const dist = levenshtein.get(canonical, candCanon);
  const maxLen = Math.max(canonical.length, candCanon.length, 1);
  const similarity = 1 - (dist / maxLen);
  return { record: candidate, score: similarity };
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('aadhaar_format_ok');
  else if (checks.format_check > 0) reasons.push('aadhaar_last4_provided');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
