// src/validation/schemas.js
import Joi from 'joi';

export const verifyPanSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('PAN').required(),
  extracted: Joi.object({
    pan: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).optional(),
    id_hash: Joi.string().hex().length(64).optional(),
    name: Joi.string().optional(),
    dob: Joi.date().iso().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
