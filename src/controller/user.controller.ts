import { Request, Response } from 'express';
import * as userService from '../services/user.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { UserListQuery } from '../schemas/user';

export const userController = {
  async list(req: Request, res: Response) {
    const result = await userService.listUsers(requireAuth(req), query<UserListQuery>(req));
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await userService.getUser(requireAuth(req), params<IdParam>(req).id));
  },

  async create(req: Request, res: Response) {
    return created(res, await userService.createUser(requireAuth(req), req.body));
  },

  async update(req: Request, res: Response) {
    return ok(
      res,
      await userService.updateUser(requireAuth(req), params<IdParam>(req).id, req.body)
    );
  },
};
