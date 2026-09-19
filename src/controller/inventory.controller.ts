import { Request, Response } from 'express';
import * as inventoryService from '../services/inventory.service';
import { ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { LedgerQuery, StockQuery } from '../schemas/inventory';

export const inventoryController = {
  async stock(req: Request, res: Response) {
    return ok(res, await inventoryService.getStockSummary(requireAuth(req), query<StockQuery>(req)));
  },

  async ledger(req: Request, res: Response) {
    const result = await inventoryService.getLedger(requireAuth(req), query<LedgerQuery>(req));
    return okList(res, result.data, result.meta);
  },

  async byProduct(req: Request, res: Response) {
    return ok(
      res,
      await inventoryService.getStockSummary(requireAuth(req), {
        ...query<StockQuery>(req),
        productId: params<{ productId: string }>(req).productId,
      })
    );
  },

  async byBatch(req: Request, res: Response) {
    return ok(
      res,
      await inventoryService.getStockSummary(requireAuth(req), {
        ...query<StockQuery>(req),
        batchId: params<{ batchId: string }>(req).batchId,
      })
    );
  },

  async byBranch(req: Request, res: Response) {
    return ok(
      res,
      await inventoryService.getStockSummary(requireAuth(req), {
        ...query<StockQuery>(req),
        branchId: params<{ branchId: string }>(req).branchId,
      })
    );
  },
};
