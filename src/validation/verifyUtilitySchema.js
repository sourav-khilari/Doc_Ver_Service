// src/validation/verifyUtilitySchema.js
import Joi from 'joi';

export const verifyUtilitySchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('UTILITY').required(),
  extracted: Joi.object({
    consumer_name: Joi.string().required(),
    consumer_account_no_masked: Joi.string().optional(),
    id_hash: Joi.string().hex().length(64).optional(), // optional: sha256 of account_no or document_hash
    address: Joi.string().required(),
    billing_date: Joi.date().iso().required(),
    bill_type: Joi.string().valid('electricity','water','property_tax','municipal','occupancy','other').optional(),
    amount: Joi.number().optional(),
    document_hash: Joi.string().hex().length(64).optional(), // sha256(file bytes) if supplied
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
