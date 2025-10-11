// src/validation/verifyTrademarkSchema.nohash.js
import Joi from "joi";

export const verifyTrademarkSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid("TRADEMARK").required(),
  extracted: Joi.object({
    registration_no: Joi.string().optional(),      // e.g., "TM-1234567"
    application_no: Joi.string().optional(),       // e.g., "APPL-2020-001"
    mark_name: Joi.string().required(),
    class: Joi.string().optional(),                // Nice-to-have: Nice class number
    owner_name: Joi.string().optional(),
    status: Joi.string().valid("registered","pending","expired","other").optional(),
    issue_date: Joi.date().iso().optional(),
    expiry_date: Joi.date().iso().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
