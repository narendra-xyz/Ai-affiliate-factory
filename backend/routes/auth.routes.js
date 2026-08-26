const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { authLimiter } = require('../middleware/rateLimit.middleware');
const { validateBody } = require('../middleware/validate.middleware');

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/login', authLimiter, validateBody(loginSchema), (req, res) => {
  const { username, password } = req.body;

  // MVP: single admin account sourced from env vars (hash generated offline,
  // never stored/shown in plaintext). See .env.example for how to generate it.
  const validUsername = process.env.ADMIN_USERNAME;
  const validHash = process.env.ADMIN_PASSWORD_HASH;

  if (username !== validUsername || !validHash || !bcrypt.compareSync(password, validHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });

  res.json({ token });
});

module.exports = router;
