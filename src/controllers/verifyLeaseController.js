// src/controllers/verifyLeaseController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { normalizeName, normalizeId, sha256Hex } from '../utils/hash.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { v4 as uuidv4 } from 'uuid';
import levenshtein from 'fast-levenshtein';

/**
 * POST /api/verify/lease
 */
export async function verifyLeaseHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let { lessor_name, lessee_name, premises_address, start_date, end_date, document_hash, id_hash: client_hash, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, date_check: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Basic format checks
    if (lessor_name && lessee_name && premises_address) checks.format_check = 1;

    // Date plausibility: start_date <= end_date, end_date not in the past (or allow short expiries)
    const now = new Date();
    const sDate = new Date(start_date);
    const eDate = new Date(end_date);
    if (sDate <= eDate) checks.date_check = 1;
    else checks.date_check = 0;

    // If lease already expired significantly (end_date < now - 365d), penalize
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    if (eDate < new Date(now - oneYearMs)) {
      // old lease; lower confidence
      checks.date_check = Math.min(checks.date_check, 0.4);
    }

    // Exact lookup by document_hash first (preferred)
    let matchedRecord = null;
    if (document_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'LEASE', id_hash: document_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_document_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // If client supplied composite id_hash (normalized lessor+lessee+address), try exact lookup
    if (!matchedRecord && client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'LEASE', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_composite_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // If no exact match, fuzzy lookup: search by premises_address & names
    if (!matchedRecord) {
      // Basic query: doc_type + address regex or partial match
      const addrNorm = premises_address.toLowerCase().trim();
      const candidates = await AuthoritativeRecord.find({ doc_type: 'LEASE', address: { $regex: addrNorm.split(' ').slice(0,4).join(' '), $options: 'i' } }).limit(200).lean();

      // If no candidates by regex, broaden to same doc_type
      let effectiveCandidates = candidates && candidates.length ? candidates : await AuthoritativeRecord.find({ doc_type: 'LEASE' }).limit(200).lean();

      // Score candidates by name & address similarity
      const lessorCanon = normalizeName(lessor_name);
      const lesseeCanon = normalizeName(lessee_name);
      const scored = effectiveCandidates.map(c => {
        const candAddr = (c.address || '').toLowerCase();
        const candLessor = c.canonical_name || (c.raw && c.raw.lessor_name) || '';
        // compute name similarity (lessor) and address similarity
        const nameDist = levenshtein.get(lessorCanon, normalizeName(candLessor || ''));
        const nameMax = Math.max(lessorCanon.length, (candLessor||'').length, 1);
        const nameSim = 1 - (nameDist / nameMax);

        const addrDist = levenshtein.get(addrNorm, candAddr || '');
        const addrMax = Math.max(addrNorm.length, (candAddr||'').length, 1);
        const addrSim = 1 - (addrDist / addrMax);

        // weighted similarity: address heavier for leases
        const combined = (0.6 * addrSim) + (0.4 * nameSim);
        return { record: c, score: combined };
      });

      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= 0.60) {
        matchedRecord = { record: best.record, match_type: 'fuzzy_address_name', score: best.score };
        checks.db_match_score = best.score;
      }
    }

    // Combine DB match, format, and dates into final confidence
    // We include date_check as a bonus (multiply into format weight)
    const combinedFormat = (checks.format_check + checks.date_check) / 2; // 0..1
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: combinedFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'LEASE',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask sensitive details)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        address: matchedRecord.record.address || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyLeaseHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}


function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check) reasons.push('basic_fields_present');
  if (checks.date_check === 1) reasons.push('dates_ok');
  else reasons.push('date_issue');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
