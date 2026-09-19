import { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { created, ok } from '../handlers/response';
import { requireAuth } from '../context/authContext';

export const authController = {
  async signup(req: Request, res: Response) {
    const result = await authService.signup(req.body, req.headers['user-agent']);
    return created(res, result);
  },

  async login(req: Request, res: Response) {
    const result = await authService.login(req.body, req.headers['user-agent']);
    return ok(res, result);
  },

  async refresh(req: Request, res: Response) {
    const result = await authService.refresh(req.body.refreshToken, req.headers['user-agent']);
    return ok(res, result);
  },

  async logout(req: Request, res: Response) {
    await authService.logout(req.body.refreshToken);
    return ok(res, { loggedOut: true });
  },

  async logoutAll(req: Request, res: Response) {
    await authService.logoutAllSessions(requireAuth(req).userId);
    return ok(res, { loggedOut: true });
  },

  async me(req: Request, res: Response) {
    return ok(res, await authService.me(requireAuth(req).userId));
  },
};
