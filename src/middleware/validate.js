// src/middleware/validate.js
export default function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, allowUnknown: false });
    if (error) {
      return res.status(400).json({ error: 'validation_error', details: error.details.map(d => d.message) });
    }
    req.body = value;
    return next();
  };
}
