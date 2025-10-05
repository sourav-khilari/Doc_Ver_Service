// src/controllers/verifyBankChequeController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/bank-cheque
 */
export async function verifyBankChequeHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let {
      account_holder_name, account_no_masked, id_hash: client_hash, ifsc,
      bank_name, branch, account_type, cheque_number, cheque_date, document_hash, ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = {
      format_check: 0,       // presence and IFSC format
      recent_cheque_score: 0,// cheque_date recency (if present)
      db_match_score: 0,
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format presence: require name + either masked account or IFSC+bank name
    if (account_holder_name && (account_no_masked || (ifsc && bank_name))) checks.format_check = 1;
    else checks.format_check = 0.5;

    // IFSC check if present
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) checks.format_check = Math.min(checks.format_check, 0.6);

    // cheque_date recency: <= 180 days -> 1, <= 365 -> 0.6, else 0
    const now = new Date();
    if (cheque_date) {
      const cDate = new Date(cheque_date);
      const days = Math.floor((now - cDate) / (1000*60*60*24));
      if (days <= 180) checks.recent_cheque_score = 1;
      else if (days <= 365) checks.recent_cheque_score = 0.6;
      else checks.recent_cheque_score = 0;
    } else {
      checks.recent_cheque_score = 0.5; // unknown
    }

    // Exact lookup: document_hash (preferred), client id_hash, or masked account
    let matchedRecord = null;
    if (document_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'BANK_CHEQUE', id_hash: document_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_document_hash' }; checks.db_match_score = 1.0; }
    }

    if (!matchedRecord && client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'BANK_CHEQUE', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    }

    if (!matchedRecord && account_no_masked) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'BANK_CHEQUE', id_masked: account_no_masked }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_masked' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: match account_holder_name + bank_name similarity
    if (!matchedRecord) {
      const query = { doc_type: 'BANK_CHEQUE' };
      // try to filter by bank_name to reduce candidates
      if (bank_name) query['raw.bank_name'] = { $regex: bank_name.split(' ').slice(0,3).join(' '), $options: 'i' };
      let candidates = await AuthoritativeRecord.find(query).limit(200).lean();
      if (!candidates || candidates.length === 0) candidates = await AuthoritativeRecord.find({ doc_type: 'BANK_CHEQUE' }).limit(200).lean();

      const nameCanon = normalizeName(account_holder_name || '');
      const scored = candidates.map(c => {
        const candName = c.canonical_name || (c.raw && c.raw.account_holder_name) || '';
        const candBank = (c.raw && c.raw.bank_name) || '';
        const nameDist = levenshtein.get(nameCanon, normalizeName(candName || ''));
        const nameMax = Math.max(nameCanon.length, (candName||'').length, 1);
        const nameSim = 1 - (nameDist / nameMax);

        let bankSim = 0;
        if (bank_name && candBank) {
          const bankDist = levenshtein.get(bank_name.toLowerCase(), candBank.toLowerCase());
          const bankMax = Math.max(bank_name.length, (candBank||'').length, 1);
          bankSim = 1 - (bankDist / bankMax);
        }

        // weight name more heavily
        const combined = (0.75 * nameSim) + (0.25 * bankSim);
        return { record: c, score: combined };
      });

      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= 0.62) {
        matchedRecord = { record: best.record, match_type: 'fuzzy_name_bank', score: best.score };
        checks.db_match_score = best.score;
      }
    }

    // Combine recent_cheque_score into format composite
    const compositeFormat = (checks.format_check + checks.recent_cheque_score) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: compositeFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'BANK_CHEQUE',
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
        bank_name: matchedRecord.record.raw?.bank_name || null,
        branch: matchedRecord.record.raw?.branch || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error('verifyBankChequeHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('fields_present');
  if (checks.recent_cheque_score === 1) reasons.push('cheque_recent_<=_180d');
  else if (checks.recent_cheque_score === 0.6) reasons.push('cheque_within_365d');
  else reasons.push('cheque_old_or_unknown');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
