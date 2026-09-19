import { Request, Response } from 'express';
import * as productService from '../services/product.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { ProductListQuery } from '../schemas/product';

export const productController = {
  async list(req: Request, res: Response) {
    const result = await productService.listProducts(
      requireAuth(req),
      query<ProductListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await productService.getProduct(requireAuth(req), params<IdParam>(req).id));
  },

  async create(req: Request, res: Response) {
    return created(res, await productService.createProduct(requireAuth(req), req.body));
  },

  async update(req: Request, res: Response) {
    return ok(
      res,
      await productService.updateProduct(requireAuth(req), params<IdParam>(req).id, req.body)
    );
  },
};
