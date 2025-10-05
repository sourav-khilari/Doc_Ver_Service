// src/controllers/verifyPassportController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/passport
 */
export async function verifyPassportHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let {
      passport_no_masked, passport_no, id_hash: client_hash,
      name, dob, nationality, gender, issue_date, expiry_date, place_of_issue, ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = {
      format_check: 0,       // passport number presence / mask
      date_validity: 0,      // expiry check
      db_match_score: 0,
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format checks
    if (passport_no || passport_no_masked) checks.format_check = 1;
    else checks.format_check = 0;

    // Expiry check if expiry_date given
    const now = new Date();
    if (expiry_date) {
      const e = new Date(expiry_date);
      checks.date_validity = e >= now ? 1 : 0;
    } else {
      checks.date_validity = 0.5; // unknown
    }

    // Exact lookup: prefer client-supplied id_hash (sha256 of normalized passport_no)
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PASSPORT', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    }

    // If passport_no provided and policy allows, compute and look up hash
    if (!matchedRecord && passport_no) {
      const hash = sha256Hex(normalizeId(passport_no));
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PASSPORT', id_hash: hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_passport_hash' }; checks.db_match_score = 1.0; }
    }

    // If not found, try masked lookup
    if (!matchedRecord && passport_no_masked) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PASSPORT', id_masked: passport_no_masked }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_masked' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: name + dob (strong signal) + nationality optionally
    if (!matchedRecord && name) {
      // prefer searching PASSPORT or PROMOTER_KYC
      const candidates = await AuthoritativeRecord.find({ doc_type: { $in: ['PASSPORT', 'PROMOTER_KYC'] } }).limit(500).lean();
      if (candidates && candidates.length) {
        const nameCanon = normalizeName(name);
        const scored = candidates.map(c => {
          const candName = c.canonical_name || (c.raw && c.raw.name) || '';
          const nameDist = levenshtein.get(nameCanon, normalizeName(candName || ''));
          const nameMax = Math.max(nameCanon.length, (candName||'').length, 1);
          const nameSim = 1 - (nameDist / nameMax);
          // dob exact match boost
          let dobBoost = 0;
          if (dob && c.dob) {
            try {
              if (new Date(dob).toISOString().slice(0,10) === new Date(c.dob).toISOString().slice(0,10)) dobBoost = 0.25;
            } catch (e) { /* ignore */ }
          }
          // nationality match small boost
          let natBoost = 0;
          if (nationality && (c.raw && c.raw.nationality)) {
            if (nationality.toLowerCase() === String(c.raw.nationality).toLowerCase()) natBoost = 0.1;
          }
          const score = Math.min(1, nameSim + dobBoost + natBoost);
          return { record: c, score };
        });
        scored.sort((a,b) => b.score - a.score);
        const best = scored[0];
        if (best && best.score >= 0.66) {
          matchedRecord = { record: best.record, match_type: 'fuzzy_name_dob', score: best.score };
          checks.db_match_score = best.score;
        }
      }
    }

    // Composite format includes date_validity (expiry)
    const compositeFormat = (checks.format_check + checks.date_validity) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: compositeFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'PASSPORT',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask sensitive values)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        name: matchedRecord.record.canonical_name || null,
        nationality: matchedRecord.record.raw?.nationality || null,
        expiry_date: matchedRecord.record.expiry_date || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyPassportHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}



function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('passport_fields_present');
  if (checks.date_validity === 1) reasons.push('passport_not_expired');
  else if (checks.date_validity === 0.5) reasons.push('passport_expiry_unknown');
  else reasons.push('passport_expired');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
