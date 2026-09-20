import { Router } from 'express';
import { authController } from '../controller/auth.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authenticateUser } from '../middleware/authenticateUser';
import { rateLimit } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { config } from '../config/env';
import { loginSchema, logoutSchema, refreshSchema, signupSchema } from '../schemas/auth';

const router = Router();

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.signupRateLimit,
  message: 'Too many signup attempts. Please try again later.',
});

/**
 * Login is throttled for a different reason than signup: signup is about abuse
 * of a tenant-creating endpoint, this is about credential stuffing. The limit is
 * per client address and deliberately generous enough that a real user
 * mistyping a password several times, or a shared office NAT, is never locked
 * out - it exists to make an automated password sweep uneconomic, not to police
 * humans.
 */
const loginLimiter = rateLimit({
  windowMs: config.loginRateLimitWindowMs,
  max: config.loginRateLimit,
  message: 'Too many login attempts. Please try again later.',
});

// The throttle sits behind validation so a user fixing typos does not spend the
// quota; a scripted abuser sends well-formed bodies and is still counted.
router.post(
  '/signup',
  validateBody(signupSchema),
  signupLimiter,
  asyncHandler(authController.signup)
);
router.post(
  '/login',
  validateBody(loginSchema),
  loginLimiter,
  asyncHandler(authController.login)
);
router.post('/refresh', validateBody(refreshSchema), asyncHandler(authController.refresh));
router.post('/logout', validateBody(logoutSchema), asyncHandler(authController.logout));
router.post('/logout-all', authenticateUser, asyncHandler(authController.logoutAll));
router.get('/me', authenticateUser, asyncHandler(authController.me));

export default router;
