import { Request, Response } from 'express';
import * as creditNoteService from '../services/creditNote.service';
import { getDocumentDetail } from '../services/document.service';
import { created, ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { DocumentListQuery, IdParam } from '../schemas/common';

export const creditNoteController = {
  async create(req: Request, res: Response) {
    return created(res, await creditNoteService.createCreditNote(requireAuth(req), req.body));
  },

  async list(req: Request, res: Response) {
    const result = await creditNoteService.listCreditNotes(
      requireAuth(req),
      query<DocumentListQuery>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async getById(req: Request, res: Response) {
    return ok(res, await getDocumentDetail(requireAuth(req), params<IdParam>(req).id));
  },
};
