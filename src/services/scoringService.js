// src/services/scoringService.js

const DEFAULT_WEIGHTS = {
  db: parseFloat(process.env.WT_DB_MATCH || '0.5'),
  format: parseFloat(process.env.WT_FORMAT || '0.25'),
  ocr: parseFloat(process.env.WT_OCR || '0.25')
};

const DEFAULT_THRESHOLDS = {
  verified: parseFloat(process.env.THRESH_VERIFIED || '0.85'),
  manual: parseFloat(process.env.THRESH_MANUAL || '0.6')
};

export function computeFinalConfidence({ db_match_score = 0, format_check = 0, ocr_confidence = 0 }) {
  const w = DEFAULT_WEIGHTS;
  return (db_match_score * w.db) + (format_check * w.format) + (ocr_confidence * w.ocr);
}

export function decideStatus(confidence) {
  if (confidence >= DEFAULT_THRESHOLDS.verified) return 'VERIFIED';
  if (confidence >= DEFAULT_THRESHOLDS.manual) return 'MANUAL_REVIEW';
  return 'REJECTED';
}
