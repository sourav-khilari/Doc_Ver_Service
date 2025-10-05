// src/validation/verifyPassportSchema.js
import Joi from 'joi';

export const verifyPassportSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('PASSPORT').required(),
  extracted: Joi.object({
    passport_no_masked: Joi.string().optional(),    // e.g. "X1234567" or "*****4567"
    passport_no: Joi.string().pattern(/^[A-Z0-9]{6,9}$/).optional(), // accept if allowed by policy
    id_hash: Joi.string().hex().length(64).optional(), // preferred (sha256 of normalized passport_no)
    name: Joi.string().required(),
    dob: Joi.date().iso().required(),
    nationality: Joi.string().optional(),
    gender: Joi.string().valid('M','F','O').optional(),
    issue_date: Joi.date().iso().optional(),
    expiry_date: Joi.date().iso().optional(),
    place_of_issue: Joi.string().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
