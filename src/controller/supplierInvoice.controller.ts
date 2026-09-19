import { Request, Response } from 'express';
import * as invoiceService from '../services/supplierInvoice.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const supplierInvoiceController = {
  async create(req: Request, res: Response) {
    return created(res, await invoiceService.createSupplierInvoice(requireAuth(req), req.body));
  },

  async list(req: Request, res: Response) {
    const result = await invoiceService.listSupplierInvoices(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await invoiceService.getInvoice(requireAuth(req), params<IdParam>(req).id));
  },
};
