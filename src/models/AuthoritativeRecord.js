// src/models/AuthoritativeRecord.js
import mongoose from 'mongoose';

const { Schema } = mongoose;

const AuthoritativeRecordSchema = new Schema({
  doc_type: { type: String, required: true, index: true }, // e.g., "PAN"
  lookup_key: { type: String },
  id_hash: { type: String, required: true, index: true },  // sha256(normalized_id)
  id_masked: { type: String },
  canonical_name: { type: String, index: true },           // normalized name
  dob: { type: Date },
  address: { type: String },
  raw: { type: Schema.Types.Mixed },                       // encrypted in prod if PII
  source: { type: String },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Unique index per doc_type + id_hash
AuthoritativeRecordSchema.index({ doc_type: 1, id_hash: 1 }, { unique: true });

export default mongoose.model('AuthoritativeRecord', AuthoritativeRecordSchema);
