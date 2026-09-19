import { Request, Response } from 'express';
import * as branchService from '../services/branch.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { BranchListQuery } from '../schemas/branch';

export const branchController = {
  async list(req: Request, res: Response) {
    const result = await branchService.listBranches(requireAuth(req), query<BranchListQuery>(req));
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await branchService.getBranch(requireAuth(req), params<IdParam>(req).id));
  },

  async create(req: Request, res: Response) {
    return created(res, await branchService.createBranch(requireAuth(req), req.body));
  },

  async update(req: Request, res: Response) {
    return ok(
      res,
      await branchService.updateBranch(requireAuth(req), params<IdParam>(req).id, req.body)
    );
  },
};
