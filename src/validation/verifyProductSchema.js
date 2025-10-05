// src/validation/verifyProductSchema.js
import Joi from 'joi';

export const verifyProductSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('PRODUCT_DOSSIER').required(),
  extracted: Joi.object({
    product_name: Joi.string().required(),
    product_code: Joi.string().optional(),
    id_hash: Joi.string().hex().length(64).optional(),
    category: Joi.string().valid('classical','proprietary','other').optional(),
    dosage_form: Joi.string().optional(),
    pack_size: Joi.string().optional(),
    pharmacopoeia_ref: Joi.string().optional(),
    mfr_formula_ref: Joi.string().optional(),
    label_key_claims: Joi.array().items(Joi.string()).optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
