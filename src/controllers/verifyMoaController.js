// src/controllers/verifyMoaController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/moa
 */
export async function verifyMoaHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      entity_type,
      directors_partners_list = [],
      authorized_signatory,
      main_objects,
      document_hash,
      id_hash: client_doc_hash,
      ocr_confidence
    } = extracted;
    console.log('verifyMoaHandler extracted:', extracted);
    const verification_id = `ver-${uuidv4()}`;

    // base checks
    const checks = {
      format_check: 0,        // presence of essential fields
      doc_match_score: 0,    // 1 if exact doc found via doc hash
      directors_match_score: 0, // average match score for directors
      authorized_signatory_match: 0, // 1 if signatory matched to known director or authoritative record
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format/presence check
    if (entity_type && directors_partners_list.length >= 1 && authorized_signatory && main_objects) {
      checks.format_check = 1;
    } else {
      // partial presence scoring
      let p = 0;
      if (entity_type) p += 0.3;
      if (directors_partners_list.length >= 1) p += 0.4;
      if (authorized_signatory) p += 0.2;
      if (main_objects) p += 0.1;
      checks.format_check = Number(p.toFixed(2));
    }

    // 1) Exact doc match by document_hash
    let matchedDocRecord = null;
    if (document_hash) {
      const docRec = await AuthoritativeRecord.findOne({ doc_type: 'MOA', id_hash: document_hash }).lean();
      if (docRec) {
        matchedDocRecord = docRec;
        checks.doc_match_score = 1.0;
      }
    }

    // 2) Try client-supplied doc id_hash (composite) if available and no document_hash exact
    if (!matchedDocRecord && client_doc_hash) {
      const docRec = await AuthoritativeRecord.findOne({ doc_type: 'MOA', id_hash: client_doc_hash }).lean();
      if (docRec) {
        matchedDocRecord = docRec;
        checks.doc_match_score = 1.0;
      }
    }

    // 3) Directors/partners verification: for each director try:
    //    - if id_hash provided: exact lookup in AuthoritativeRecord (check types PAN/AADHAAR/PROMOTER_KYC)
    //    - else fuzzyLookupByNameDob against PROMOTER_KYC / PAN collections
    const directorScores = [];
    for (const person of directors_partners_list) {
      const personScore = { input: person, matched: null, score: 0, reasons: [] };

      // exact by provided id_hash
      if (person.id_hash) {
        const rec = await AuthoritativeRecord.findOne({
          doc_type: { $in: ['PROMOTER_KYC', 'PAN', 'TECH_CERT', 'PROMOTER'] },
          id_hash: person.id_hash
        }).lean();
        if (rec) {
          personScore.matched = { record: rec, match_type: 'exact_id_hash' };
          personScore.score = 1.0;
          personScore.reasons.push('exact_id_hash');
          directorScores.push(personScore);
          continue;
        }
      }

      // exact by masked id (if present) -> compute normalized masked? We'll attempt a lookup by id_masked
      if (person.id_no_masked) {
        const rec = await AuthoritativeRecord.findOne({
          doc_type: { $in: ['PROMOTER_KYC', 'PAN'] },
          id_masked: person.id_no_masked
        }).lean();
        if (rec) {
          personScore.matched = { record: rec, match_type: 'exact_id_masked' };
          personScore.score = 1.0;
          personScore.reasons.push('exact_id_masked');
          directorScores.push(personScore);
          continue;
        }
      }

      // fuzzy fallback by name + dob (if dob available)
      if (person.name) {
        // try PROMOTER_KYC first (if you seed promoters separately), else PAN
        let fuzzy = await fuzzyLookupByNameDob('PROMOTER_KYC', person.name, person.dob);
        if (!fuzzy) fuzzy = await fuzzyLookupByNameDob('PAN', person.name, person.dob);
        if (!fuzzy) fuzzy = await fuzzyLookupByNameDob('TECH_CERT', person.name, person.dob);
        if (fuzzy) {
          personScore.matched = { record: fuzzy.record, match_type: 'fuzzy_name_dob' };
          personScore.score = fuzzy.score || 0;
          personScore.reasons.push(`fuzzy_match_${(personScore.score).toFixed(2)}`);
          directorScores.push(personScore);
          continue;
        }
      }

      // nothing matched
      personScore.reasons.push('no_match_found');
      directorScores.push(personScore);
    }

    // compute average directors_match_score (use mean of scores)
    if (directorScores.length > 0) {
      const sum = directorScores.reduce((acc, p) => acc + (p.score || 0), 0);
      checks.directors_match_score = Number((sum / directorScores.length).toFixed(4));
    } else {
      checks.directors_match_score = 0;
    }

    // 4) Authorized signatory: check if it matches any matched director OR has its own id match
    let authMatch = 0;
    if (authorized_signatory) {
      // try exact id_hash
      if (authorized_signatory.id_hash) {
        const rec = await AuthoritativeRecord.findOne({
          doc_type: { $in: ['PROMOTER_KYC','PAN','TECH_CERT'] },
          id_hash: authorized_signatory.id_hash
        }).lean();
        if (rec) authMatch = 1.0;
      }
      // else check if name equals any director matched record with high score
      if (!authMatch && authorized_signatory.name) {
        const authNameNorm = normalizeName(authorized_signatory.name);
        for (const ds of directorScores) {
          const recName = ds.matched?.record?.canonical_name || (ds.input && ds.input.name) || '';
          if (recName && normalizeName(recName) === authNameNorm && (ds.score >= 0.9 || ds.score === 1.0)) {
            authMatch = 1.0;
            break;
          }
        }
      }
    }
    checks.authorized_signatory_match = authMatch;

    // 5) Combine to final confidence.
    // We'll use weights: doc_match (0.35), directors_match (0.45), format (0.1), ocr (0.1)
    // But use existing scoringService which expects db_match_score + format_check + ocr; so compute db_match_score as composite:
    const composite_db = Math.max(checks.doc_match_score, checks.directors_match_score); // conservative: if doc or directors match well
    // Put format_check as checks.format_check, ocr_confidence as checks.ocr_confidence
    // Adjust: add authorized_signatory_match boost to db composite
    const db_with_auth = Math.min(1, composite_db + (checks.authorized_signatory_match * 0.05)); // tiny bump
    const final_confidence = computeFinalConfidence({ db_match_score: db_with_auth, format_check: checks.format_check, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit + include director matching details
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'MOA',
      extracted,
      checks,
      matched_record_id: matchedDocRecord?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedDocRecord),
      // add a verbose field for reviewers (not sensitive if raw kept encrypted; included here for dev)
      directors_review: directorScores
    });

    // response: include director matching summary but mask sensitive IDs
    const matched_directors_summary = directorScores.map(d => ({
      input_name: d.input?.name,
      matched_record_id: d.matched?.record?._id ?? null,
      match_type: d.matched?.match_type ?? null,
      score: d.score,
      reasons: d.reasons
    }));

    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_doc: matchedDocRecord ? {
        record_id: matchedDocRecord._id,
        id_masked: matchedDocRecord.id_masked || null,
        entity_type: matchedDocRecord.doc_type || null
      } : null,
      directors: matched_directors_summary,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyMoaHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedDocRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('moa_fields_present');
  else reasons.push('moa_partial_fields');
  if (checks.doc_match_score === 1.0) reasons.push('exact_doc_match');
  if (checks.directors_match_score > 0.8) reasons.push('directors_all_high_confidence');
  else if (checks.directors_match_score > 0.5) reasons.push('directors_partial_match');
  else reasons.push('directors_no_match');
  if (checks.authorized_signatory_match === 1) reasons.push('authorized_signatory_matched');
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  return reasons;
}
