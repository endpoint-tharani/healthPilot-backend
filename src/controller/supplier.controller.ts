import { Request, Response } from 'express';
import * as supplierService from '../services/supplier.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { SupplierListQuery } from '../schemas/supplier';

export const supplierController = {
  async list(req: Request, res: Response) {
    const result = await supplierService.listSuppliers(
      requireAuth(req),
      query<SupplierListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await supplierService.getSupplier(requireAuth(req), params<IdParam>(req).id));
  },

  async create(req: Request, res: Response) {
    return created(res, await supplierService.createSupplier(requireAuth(req), req.body));
  },

  async update(req: Request, res: Response) {
    return ok(
      res,
      await supplierService.updateSupplier(requireAuth(req), params<IdParam>(req).id, req.body)
    );
  },
};
