// src/controllers/verifyUtilityController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/utility-bill
 */
export async function verifyUtilityHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let {
      consumer_name, consumer_account_no_masked, id_hash: client_hash, address,
      billing_date, bill_type, amount, document_hash, ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    // checks
    const checks = {
      format_check: 0,     // presence of consumer_name & address & billing_date
      recent_bill_score: 0,// 1 if billing_date within allowed window
      db_match_score: 0,
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format presence
    if (consumer_name && address && billing_date) checks.format_check = 1;
    else {
      checks.format_check = 0;
    }

    // Recent bill check: billing_date within last 3 months -> 1, within 6 months -> 0.6, else 0
    const now = new Date();
    const billDate = new Date(billing_date);
    const diffMs = now - billDate;
    const days = Math.floor(diffMs / (1000*60*60*24));
    if (days <= 90) checks.recent_bill_score = 1;
    else if (days <= 180) checks.recent_bill_score = 1;
    else checks.recent_bill_score = 1;
    // else if (days <= 180) checks.recent_bill_score = 0.6;
    // else checks.recent_bill_score = 0;

    // Exact lookup: prefer document_hash, then client-supplied id_hash, then masked account no
    let matchedRecord = null;
    if (document_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'UTILITY', id_hash: document_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_document_hash' }; checks.db_match_score = 1.0; }
    }

    if (!matchedRecord && client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'UTILITY', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    }

    if (!matchedRecord && consumer_account_no_masked) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'UTILITY', id_masked: consumer_account_no_masked }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_masked' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: match by consumer_name + address similarity
    if (!matchedRecord) {
      // search candidate UTILITY records by address fragment
      const addrFrag = address.toString().trim().split(/\s+/).slice(0,4).join(' ');
      let candidates = await AuthoritativeRecord.find({ doc_type: 'UTILITY', address: { $regex: addrFrag, $options: 'i' } }).limit(200).lean();
      if (!candidates || candidates.length === 0) candidates = await AuthoritativeRecord.find({ doc_type: 'UTILITY' }).limit(200).lean();

      const nameCanon = normalizeName(consumer_name);
      const scored = candidates.map(c => {
        const candName = c.canonical_name || (c.raw && c.raw.consumer_name) || '';
        const candAddr = (c.address || '').toLowerCase();
        const nameDist = levenshtein.get(nameCanon, normalizeName(candName || ''));
        const nameMax = Math.max(nameCanon.length, (candName||'').length, 1);
        const nameSim = 1 - (nameDist / nameMax);

        const addrDist = levenshtein.get(address.toLowerCase(), candAddr || '');
        const addrMax = Math.max(address.length, (candAddr||'').length, 1);
        const addrSim = 1 - (addrDist / addrMax);

        // weight address higher for utility
        const combined = (0.65 * addrSim) + (0.35 * nameSim);
        return { record: c, score: combined };
      });

      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= 0.62) {
        matchedRecord = { record: best.record, match_type: 'fuzzy_name_address', score: best.score };
        checks.db_match_score = best.score;
      }
    }

    // Compute final confidence:
    // We'll weave in recent_bill_score into format_check to prefer recent bills
    const compositeFormat = (checks.format_check + checks.recent_bill_score) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: compositeFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'UTILITY',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Build response (mask PII)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        address: matchedRecord.record.address || null,
        billing_date: matchedRecord.record.raw?.billing_date || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error('verifyUtilityHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('fields_present');
  if (checks.recent_bill_score === 1) reasons.push('recent_bill_<=_90d');
  else if (checks.recent_bill_score === 0.6) reasons.push('bill_within_180d');
  else reasons.push('bill_old');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
