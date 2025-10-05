// src/validation/verifyBoardResSchema.js
import Joi from 'joi';

const idTypes = ['PAN','AADHAAR','PASSPORT','OTHER'];

export const verifyBoardResSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('BOARD_RES').required(),
  extracted: Joi.object({
    resolution_no: Joi.string().optional(),
    resolution_date: Joi.date().iso().required(),
    purpose: Joi.string().optional(),
    // authorized_person object
    authorized_person: Joi.object({
      name: Joi.string().required(),
      id_type: Joi.string().valid(...idTypes).optional(),
      id_no_masked: Joi.string().optional(),
      id_hash: Joi.string().hex().length(64).optional(),
      dob: Joi.date().iso().optional()
    }).required(),
    document_hash: Joi.string().hex().length(64).optional(),
    id_hash: Joi.string().hex().length(64).optional(), // composite id for doc if available
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
