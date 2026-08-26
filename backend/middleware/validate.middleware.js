// Generic request validator using zod schemas. Every route that accepts
// user input should validate it here before touching the database or
// calling an agent, per the "validasi semua input" requirement.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request body', details: result.error.flatten() });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody };
