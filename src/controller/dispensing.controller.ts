import { Request, Response } from 'express';
import * as dispensingService from '../services/dispensing.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const dispensingController = {
  async create(req: Request, res: Response) {
    return created(res, await dispensingService.createDispensing(requireAuth(req), req.body));
  },

  async list(req: Request, res: Response) {
    const result = await dispensingService.listDispensing(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },
};
