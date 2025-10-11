// src/controllers/verifyElectricityController.nohash.js
import AuthoritativeRecord from "../models/AuthoritativeRecord.js";
import Verification from "../models/Verification.js";
import { computeFinalConfidence, decideStatus } from "../services/scoringService.js";
import levenshtein from "fast-levenshtein";
import { v4 as uuidv4 } from "uuid";

/**
 * POST /api/verify/electricity-bill  (no-hash)
 *
 * Uses human-readable fields only: masked account no, service connection no, meter no,
 * distributor name, consumer name, billing date, energy_kwh etc.
 *
 * Strategy:
 *  - exact lookups against authoritative_records.raw.registration_no | raw.account_no | id_masked
 *  - fuzzy name+address+discom match if exact fails
 *  - plausibility checks: recency, consumption vs sanctioned load, sudden spike detection
 *  - compute component scores and final_confidence using computeFinalConfidence()
 */
export async function verifyElectricityHandlerNoHash(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      consumer_name,
      consumer_account_no_masked,
      service_connection_no,
      meter_no,
      distributor_name,
      billing_date,
      billing_period_from,
      billing_period_to,
      due_date,
      bill_amount,
      energy_kwh,
      sanctioned_load_kw,
      consumer_category,
      address,
      account_status,
      bill_number,
      ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    // components & checks
    const checks = {
      format_check: 0,          // presence of key fields
      recency_score: 0,        // billing_date recency
      db_match_score: 0,       // match to authoritative electricity bill or consumer index
      consumption_plausibility: 0, // 0..1
      ocr_confidence: (ocr_confidence ?? 0)
    };

    const components = {
      consumer_record: { required: true, matched: false, score: 0, record: null },
      discom_record: { required: false, matched: false, score: 0, record: null },
      billing_recent: { required: true, matched: false, score: 0 },
      consumption_plausible: { required: true, matched: false, score: 0 }
    };

    // Helper: exact lookup by stored registration/account numbers or id_masked
    async function exactLookupElectricity(value) {
      if (!value) return null;
      const q = { doc_type: { $in: ["ELECTRICITY_BILL", "UTILITY", "LEASE", "INCORP"] } };
      q["$or"] = [
        { "raw.account_no": value },
        { "raw.service_connection_no": value },
        { "raw.bill_number": value },
        { "id_masked": value },
        { "raw.registration_no": value }
      ];
      return await AuthoritativeRecord.findOne(q).lean();
    }

    // Fuzzy lookup by name + address + distributor
    async function fuzzyLookupConsumer(name, addr, discom, threshold = 0.62) {
      if (!name) return null;
      const q = { doc_type: { $in: ["ELECTRICITY_BILL", "UTILITY", "INCORP", "PROMOTER_KYC"] } };
      // limit candidates to those with the discom or address fragment if possible to reduce noise
      let candidates = [];
      if (discom) {
        candidates = await AuthoritativeRecord.find({ doc_type: { $in: ["ELECTRICITY_BILL", "UTILITY"] }, "raw.distributor_name": { $regex: discom.split(" ").slice(0,3).join(" "), $options: "i" } }).limit(500).lean();
      }
      if (!candidates || candidates.length === 0) {
        // fallback to address fragment or all ELECTRICITY_BILL records
        const addrFrag = addr ? addr.split(/\s+/).slice(0,4).join(" ") : null;
        candidates = addrFrag
          ? await AuthoritativeRecord.find({ doc_type: { $in: ["ELECTRICITY_BILL", "UTILITY"] }, address: { $regex: addrFrag, $options: "i" } }).limit(500).lean()
          : await AuthoritativeRecord.find({ doc_type: { $in: ["ELECTRICITY_BILL", "UTILITY"] } }).limit(500).lean();
      }
      if (!candidates || candidates.length === 0) return null;

      const nameCanon = name.toString().toLowerCase().trim();
      const scored = candidates.map(c => {
        const candName = (c.canonical_name || (c.raw && (c.raw.consumer_name || c.raw.account_name)) || "").toString().toLowerCase();
        const dist = levenshtein.get(nameCanon, candName);
        const maxLen = Math.max(nameCanon.length, candName.length, 1);
        const sim = 1 - (dist / maxLen);
        // boost if distributor matches
        let boost = 0;
        if (discom && c.raw && c.raw.distributor_name) {
          const dA = discom.toLowerCase();
          const dB = c.raw.distributor_name.toLowerCase();
          const dDist = levenshtein.get(dA, dB);
          const dMax = Math.max(dA.length, dB.length, 1);
          const dSim = 1 - (dDist / dMax);
          if (dSim > 0.7) boost += 0.15;
        }
        // boost small for address similarity
        if (addr && c.address) {
          const aA = addr.toLowerCase();
          const aB = c.address.toLowerCase();
          const aDist = levenshtein.get(aA, aB);
          const aMax = Math.max(aA.length, aB.length, 1);
          const aSim = 1 - (aDist / aMax);
          if (aSim > 0.6) boost += 0.12;
        }
        const score = Math.min(1, sim + boost);
        return { record: c, score };
      });
      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= threshold) return best;
      return null;
    }

    // 1) Format check (consumer_name + billing_date required)
    if (consumer_name && billing_date) checks.format_check = 1;
    else checks.format_check = consumer_name ? 0.6 : 0;

    // 2) Recency: billing_date should be recent (<=90 days = 1, 180 days=0.6, else 0)
    const now = new Date();
    let billingDateObj = null;
    try { billingDateObj = new Date(billing_date); } catch (e) { billingDateObj = null; }
    if (billingDateObj) {
      const days = Math.floor((now - billingDateObj) / (1000*60*60*24));
      if (days <= 90) { checks.recency_score = 1; components.billing_recent.score = 1; components.billing_recent.matched = true; }
      else if (days <= 180) { checks.recency_score = 0.6; components.billing_recent.score = 0.6; components.billing_recent.matched = true; }
      else { checks.recency_score = 0; components.billing_recent.score = 0; components.billing_recent.matched = false; }
    } else {
      checks.recency_score = 0;
      components.billing_recent.score = 0;
    }

    // 3) Exact DB match attempts: masked account no, service connection no, bill number
    let matchedRec = null;
    if (consumer_account_no_masked) matchedRec = await exactLookupElectricity(consumer_account_no_masked);
    if (!matchedRec && service_connection_no) matchedRec = await exactLookupElectricity(service_connection_no);
    if (!matchedRec && bill_number) matchedRec = await exactLookupElectricity(bill_number);
    if (!matchedRec && meter_no) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: { $in: ["ELECTRICITY_BILL","UTILITY"] }, "raw.meter_no": meter_no }).lean();
      if (rec) matchedRec = rec;
    }
    if (matchedRec) {
      components.consumer_record.matched = true;
      components.consumer_record.score = 1.0;
      components.consumer_record.record = matchedRec;
      checks.db_match_score = 1.0;
    }

    // 4) Fuzzy fallback: name+address+discom
    if (!matchedRec) {
      const fuzzy = await fuzzyLookupConsumer(consumer_name, address, distributor_name, 0.62);
      if (fuzzy) {
        matchedRec = fuzzy.record;
        components.consumer_record.matched = true;
        components.consumer_record.score = fuzzy.score;
        components.consumer_record.record = fuzzy.record;
        checks.db_match_score = fuzzy.score;
      }
    }

    // 5) Discom authoritative lookup (by distributor_name)
    let matchedDiscom = null;
    if (distributor_name) {
      matchedDiscom = await AuthoritativeRecord.findOne({ doc_type: "DISCOM", $or: [{ "raw.distributor_name": { $regex: distributor_name.split(" ").slice(0,3).join(" "), $options: "i" } }, { id_masked: distributor_name }] }).lean();
      if (matchedDiscom) { components.discom_record.matched = true; components.discom_record.score = 1; components.discom_record.record = matchedDiscom; }
    }

    // 6) Consumption plausibility checks
    // - If sanctioned_load_kw present: estimate expected kWh per month roughly = sanctioned_load_kw * 24 * utilisation_factor(0.25..0.9) * days_in_period/30
    // - If energy_kwh present and billing_period_from/to present, compute daily and compare to expectation and detect large spikes relative to historical avg if we have matchedRec.raw.previous_month_kwh
    let consumptionScore = 0;
    try {
      const daysInPeriod = billing_period_from && billing_period_to ? Math.max(1, Math.ceil((new Date(billing_period_to) - new Date(billing_period_from)) / (1000*60*60*24))) : 30;
      let expectedKwh = null;
      if (sanctioned_load_kw && typeof sanctioned_load_kw === "number") {
        // assume utilization factor of 0.2..0.6 for companies by default -> pick 0.3 conservative
        const util = 0.30;
        expectedKwh = sanctioned_load_kw * 24 * util * (daysInPeriod / 30);
      }
      if (energy_kwh && typeof energy_kwh === "number") {
        if (expectedKwh) {
          const ratio = energy_kwh / Math.max(1, expectedKwh);
          // score: close to expected -> 1; if significantly higher or lower penalize.
          if (ratio >= 0.6 && ratio <= 1.8) consumptionScore = 1.0; // within reasonable band
          else if (ratio >= 0.4 && ratio <= 2.5) consumptionScore = 0.6;
          else consumptionScore = 0.0;
        } else if (matchedRec && matchedRec.raw && typeof matchedRec.raw.previous_month_kwh === "number") {
          const prev = matchedRec.raw.previous_month_kwh;
          if (prev === 0) consumptionScore = energy_kwh > 0 ? 0.6 : 1;
          else {
            const rel = energy_kwh / prev;
            if (rel >= 0.5 && rel <= 2.0) consumptionScore = 1.0;
            else if (rel >= 0.25 && rel <= 3.0) consumptionScore = 0.6;
            else consumptionScore = 0.0;
          }
        } else {
          consumptionScore = 0.6; // unknown baseline but presence of energy_kwh gives some credit
        }
      } else {
        consumptionScore = 0.3; // no consumption value
      }
    } catch (e) {
      consumptionScore = 0.3;
    }
    checks.consumption_plausibility = Number(consumptionScore.toFixed(3));
    components.consumption_plausible.score = checks.consumption_plausibility;
    components.consumption_plausible.matched = checks.consumption_plausibility >= 0.6;

    // 7) Final DB match score composition
    // We weight: consumer_record 0.55, discom 0.15, recency 0.15, consumption plausibility 0.15
    const weights = { consumer: 0.55, discom: 0.15, recency: 0.15, consumption: 0.15 };
    const db_score_raw = (
      (components.consumer_record.score || 0) * weights.consumer +
      (components.discom_record.score || 0) * weights.discom +
      (checks.recency_score || 0) * weights.recency +
      (checks.consumption_plausibility || 0) * weights.consumption
    );
    const weightSum = Object.values(weights).reduce((a,b) => a + b, 0);
    const normalized_db_score = db_score_raw / weightSum;
    checks.db_match_score = Number(normalized_db_score.toFixed(4));

    // 8) Format composite (presence of account no / service connection or meter no + name + billing_date)
    const hasAccountHint = !!(consumer_account_no_masked || service_connection_no || meter_no);
    const format_composite = (checks.format_check + (hasAccountHint ? 1 : 0)) / 2;

    // 9) Compute final confidence & status
    const final_confidence = computeFinalConfidence({ db_match_score: normalized_db_score, format_check: format_composite, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // 10) Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: "ELECTRICITY_BILL",
      extracted,
      checks: {
        db_score: normalized_db_score,
        format_composite,
        recency_score: checks.recency_score,
        consumption_plausibility: checks.consumption_plausibility,
        ocr_confidence: checks.ocr_confidence
      },
      components,
      matched_consumer_id: components.consumer_record.record ? components.consumer_record.record._id : null,
      matched_discom_id: components.discom_record.record ? components.discom_record.record._id : null,
      final_confidence,
      status,
      reasons: buildReasons(components, checks, normalized_db_score, final_confidence)
    });

    // 11) Build response (masking sensitive fields)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      db_score: Number(normalized_db_score.toFixed(4)),
      checks: {
        format_composite: Number(format_composite.toFixed(3)),
        recency_score: checks.recency_score,
        consumption_plausibility: checks.consumption_plausibility,
        ocr_confidence: checks.ocr_confidence
      },
      components: mapComponentsForResponse(components),
      matched_consumer: components.consumer_record.record ? {
        record_id: components.consumer_record.record._id,
        id_masked: components.consumer_record.record.id_masked || components.consumer_record.record.raw?.account_no || null,
        canonical_name: components.consumer_record.record.canonical_name || components.consumer_record.record.raw?.consumer_name || null,
        address: components.consumer_record.record.address || components.consumer_record.record.raw?.address || null
      } : null,
      matched_discom: components.discom_record.record ? {
        record_id: components.discom_record.record._id,
        id_masked: components.discom_record.record.id_masked || components.discom_record.record.raw?.registration_no || null,
        distributor_name: components.discom_record.record.raw?.distributor_name || components.discom_record.record.canonical_name || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("verifyElectricityHandlerNoHash error", err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

function buildReasons(components, checks, dbScore, finalConfidence) {
  const reasons = [];
  if (!components.consumer_record.matched) reasons.push("no_consumer_record_match");
  if (!components.discom_record.matched) reasons.push("no_discom_match");
  if (checks.recency_score === 1) reasons.push("recent_bill");
  else if (checks.recency_score === 0.6) reasons.push("bill_recent_medium");
  else reasons.push("bill_old");
  if (checks.consumption_plausibility >= 0.9) reasons.push("consumption_plausible");
  else if (checks.consumption_plausibility >= 0.6) reasons.push("consumption_plausible_partial");
  else reasons.push("consumption_not_plausible_or_unknown");
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push("low_ocr_confidence");
  reasons.push(`db_score_${dbScore.toFixed(3)}`);
  reasons.push(`final_confidence_${finalConfidence.toFixed(3)}`);
  return reasons;
}

function mapComponentsForResponse(components) {
  const out = {};
  for (const k of Object.keys(components)) {
    const c = components[k];
    out[k] = {
      required: c.required,
      matched: !!c.matched,
      score: Number((c.score || 0).toFixed(3)),
      record_preview: (c.record ? [{
        record_id: c.record._id,
        id_masked: c.record.id_masked || c.record.raw?.account_no || null,
        canonical_name: c.record.canonical_name || (c.record.raw && (c.record.raw.consumer_name || c.record.raw.account_name)) || null,
        address: c.record.address || c.record.raw?.address || null
      }] : [])
    };
  }
  return out;
}
