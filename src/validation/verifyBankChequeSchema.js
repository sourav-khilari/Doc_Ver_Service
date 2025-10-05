// src/validation/verifyBankChequeSchema.js
import Joi from 'joi';

export const verifyBankChequeSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('BANK_CHEQUE').required(),
  extracted: Joi.object({
    account_holder_name: Joi.string().required(),
    account_no_masked: Joi.string().optional(), // e.g., "XXXXXX1234"
    id_hash: Joi.string().hex().length(64).optional(), // optional sha256(account_no or document)
    ifsc: Joi.string().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
    bank_name: Joi.string().optional(),
    branch: Joi.string().optional(),
    account_type: Joi.string().valid('savings','current','other').optional(),
    cheque_number: Joi.string().optional(),
    cheque_date: Joi.date().iso().optional(),
    document_hash: Joi.string().hex().length(64).optional(), // sha256(file bytes)
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
