// src/validation/verifyMoaSchema.js
import Joi from 'joi';

const idTypes = ['PAN','AADHAAR','PASSPORT','OTHER'];

export const verifyMoaSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('MOA').required(),
  extracted: Joi.object({
    entity_type: Joi.string().required(), // LLP / Private Limited / Partnership / etc.
    directors_partners_list: Joi.array().items(
      Joi.object({
        name: Joi.string().required(),
        id_type: Joi.string().valid(...idTypes).optional(),
        id_no_masked: Joi.string().optional(),
        id_hash: Joi.string().hex().length(64).optional(),
        dob: Joi.date().iso().optional()
      })
    ).min(1).required(),
    authorized_signatory: Joi.object({
      name: Joi.string().required(),
      id_type: Joi.string().valid(...idTypes).optional(),
      id_no_masked: Joi.string().optional(),
      id_hash: Joi.string().hex().length(64).optional()
    }).required(),
    main_objects: Joi.string().optional(),
    document_hash: Joi.string().hex().length(64).optional(),
    id_hash: Joi.string().hex().length(64).optional(), // composite id for doc if available
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
