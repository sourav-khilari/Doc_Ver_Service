// src/controllers/verifyTrademarkController.nohash.js
import AuthoritativeRecord from "../models/AuthoritativeRecord.js";
import Verification from "../models/Verification.js";
import { computeFinalConfidence, decideStatus } from "../services/scoringService.js";
import levenshtein from "fast-levenshtein";
import { v4 as uuidv4 } from "uuid";

/**
 * POST /api/verify/trademark  (no-hash)
 *
 * Uses human-readable registration/application numbers and fuzzy matching on mark_name/owner_name.
 */
export async function verifyTrademarkHandlerNoHash(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      registration_no, application_no, mark_name, class: tmClass,
      owner_name, status, issue_date, expiry_date, ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    const checks = {
      format_check: 0,        // presence of mark_name + either reg/app no or owner
      db_match_score: 0,
      status_check: 0,        // 1 if status good (registered and not expired)
      expiry_check: 0,
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format check
    if (mark_name && (registration_no || application_no || owner_name)) checks.format_check = 1;
    else if (mark_name) checks.format_check = 0.6;
    else checks.format_check = 0;

    // Expiry / status checks
    const now = new Date();
    if (expiry_date) {
      const e = new Date(expiry_date);
      checks.expiry_check = e >= now ? 1 : 0;
    } else {
      checks.expiry_check = status === "registered" ? 0.8 : 0.5;
    }
    if (status === "registered") checks.status_check = checks.expiry_check;
    else if (status === "pending") checks.status_check = 0.6;
    else checks.status_check = status === "expired" ? 0 : 0.5;

    // Exact lookup helper: search raw.registration_no or raw.application_no or id_masked
    async function exactLookupByNumber(value) {
      if (!value) return null;
      const q = {
        doc_type: "TRADEMARK",
        $or: [
          { "raw.registration_no": value },
          { "raw.application_no": value },
          { "id_masked": value }
        ]
      };
      return await AuthoritativeRecord.findOne(q).lean();
    }

    // Fuzzy lookup helper by mark name + class + owner_name optionally
    async function fuzzyLookupMark(name, owner, cls, threshold = 0.62) {
      if (!name) return null;
      const q = { doc_type: "TRADEMARK" };
      if (cls) q["raw.class"] = new RegExp(`${escapeRegex(String(cls))}`, "i");
      // limit candidates
      const candidates = await AuthoritativeRecord.find(q).limit(500).lean();
      if (!candidates || candidates.length === 0) return null;
      const nameCanon = name.toString().toLowerCase().trim();
      const scored = candidates.map(c => {
        const candMark = (c.raw && (c.raw.mark_name || c.canonical_name)) ? (c.raw.mark_name || c.canonical_name) : "";
        const candMarkCanon = candMark.toString().toLowerCase();
        const dist = levenshtein.get(nameCanon, candMarkCanon);
        const maxLen = Math.max(nameCanon.length, candMarkCanon.length, 1);
        let sim = 1 - (dist / maxLen);
        // boost when owner matches textually
        if (owner && c.raw && c.raw.owner_name) {
          const ownA = owner.toString().toLowerCase();
          const ownB = c.raw.owner_name.toString().toLowerCase();
          const d2 = levenshtein.get(ownA, ownB);
          const max2 = Math.max(ownA.length, ownB.length, 1);
          const ownSim = 1 - (d2 / max2);
          sim = Math.min(1, sim + (0.2 * ownSim));
        }
        return { record: c, score: sim };
      });
      scored.sort((a,b)=>b.score - a.score);
      const best = scored[0];
      if (best && best.score >= threshold) return best;
      return null;
    }

    // 1) Exact lookup by registration_no/application_no if provided
    let matched = null;
    if (registration_no) matched = await exactLookupByNumber(registration_no);
    if (!matched && application_no) matched = await exactLookupByNumber(application_no);

    if (matched) {
      checks.db_match_score = 1.0;
    } else {
      // 2) Fuzzy lookup by mark_name (and owner_name/class if present)
      const fuzzy = await fuzzyLookupMark(mark_name, owner_name, tmClass, 0.62);
      if (fuzzy) {
        matched = fuzzy.record;
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Combine status/expiry into final DB confidence (give some weight)
    // compute an adjusted db score that includes status_check
    const adjusted_db = Math.min(1, checks.db_match_score * 0.85 + checks.status_check * 0.15);
    checks.db_match_score = adjusted_db;

    // Final confidence: use scoring service (db + format + ocr)
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: checks.format_check, ocr_confidence: checks.ocr_confidence });
    const statusResult = decideStatus(final_confidence);

    // Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: "TRADEMARK",
      extracted,
      checks,
      matched_record_id: matched ? matched._id : null,
      final_confidence,
      status: statusResult,
      reasons: buildReasons(checks, matched)
    });

    // Prepare response (masking)
    const response = {
      verification_id,
      status: statusResult,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matched ? {
        record_id: matched._id,
        id_masked: matched.id_masked || matched.raw?.registration_no || matched.raw?.application_no || null,
        mark_name: matched.raw?.mark_name || matched.canonical_name || null,
        owner_name: matched.raw?.owner_name || null,
        class: matched.raw?.class || null,
        status: matched.raw?.status || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("verifyTrademarkHandlerNoHash error", err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function buildReasons(checks, matched) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push("fields_present");
  if (checks.db_match_score === 1.0) reasons.push("exact_db_match");
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.status_check < 0.6) reasons.push("tm_status_not_preferable");
  if (checks.expiry_check === 0) reasons.push("tm_expired");
  if (!matched) reasons.push("no_db_match_found");
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push("low_ocr_confidence");
  return reasons;
}
