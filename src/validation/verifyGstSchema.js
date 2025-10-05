// src/validation/verifyGstSchema.js
import Joi from 'joi';

// GSTIN format (India) : 15 chars. We'll validate permissively with a commonly used pattern.
// Normalize to uppercase in controller.
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$/;

export const verifyGstSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('GST').required(),
  extracted: Joi.object({
    gstin: Joi.string().pattern(gstinRegex).optional(),
    id_hash: Joi.string().hex().length(64).optional(),
    legal_name: Joi.string().required(),
    trade_name: Joi.string().optional(),
    principal_place_address: Joi.string().optional(),
    state_jurisdiction: Joi.string().optional(),
    registration_date: Joi.date().iso().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
