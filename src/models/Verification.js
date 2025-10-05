// src/models/Verification.js
import mongoose from 'mongoose';

const { Schema } = mongoose;

const VerificationSchema = new Schema({
  verification_id: { type: String, unique: true, required: true },
  request_id: { type: String, required: true },
  submitted_by: { type: String },
  doc_type: { type: String, required: true },
  extracted: { type: Schema.Types.Mixed, required: true },
  checks: { type: Schema.Types.Mixed },
  matched_record_id: { type: Schema.Types.ObjectId, ref: 'AuthoritativeRecord' },
  final_confidence: { type: Number, required: true },
  status: { type: String, required: true }, // VERIFIED | MANUAL_REVIEW | REJECTED | NOT_FOUND
  reasons: [String],
  created_at: { type: Date, default: Date.now },
  reviewed_by: { type: String },
  reviewed_at: { type: Date }
});

VerificationSchema.index({ request_id: 1 });
VerificationSchema.index({ doc_type: 1, status: 1 });

export default mongoose.model('Verification', VerificationSchema);
