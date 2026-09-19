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
  asyncHandler(authController.login)
);
router.post('/refresh', validateBody(refreshSchema), asyncHandler(authController.refresh));
router.post('/logout', validateBody(logoutSchema), asyncHandler(authController.logout));
router.post('/logout-all', authenticateUser, asyncHandler(authController.logoutAll));
router.get('/me', authenticateUser, asyncHandler(authController.me));

export default router;
