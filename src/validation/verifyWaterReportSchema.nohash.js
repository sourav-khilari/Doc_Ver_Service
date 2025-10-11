// src/validation/verifyWaterReportSchema.nohash.js
import Joi from "joi";

export const verifyWaterReportSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid("WATER_REPORT").required(),
  extracted: Joi.object({
    report_no: Joi.string().optional(),            // lab report number (human readable)
    lab_name: Joi.string().required(),             // lab name extracted from OCR
    lab_registration_no: Joi.string().optional(),  // e.g., NABL reg no or lab licence no
    sample_date: Joi.date().iso().required(),
    sample_collected_from: Joi.string().optional(),// address / location
    // key parameters: object with parameter -> value (number or string). Example: { "pH": 6.8, "turbidity_NTU": 2.5, "arsenic_ppb": 5 }
    parameters: Joi.object().pattern(Joi.string(), [Joi.number(), Joi.string()]).required(),
    // optional expected limits to check compliance, same shape as parameters: { "pH": { min:6.5, max:8.5}, "arsenic_ppb": { max:10 } }
    expected_limits: Joi.object().pattern(Joi.string(), Joi.object({
      min: Joi.number().optional(),
      max: Joi.number().optional()
    })).optional(),
    // optional attached certificate/report page count or image id (kept in main backend)
    pages: Joi.number().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
