import { z } from 'zod';
import { DocumentType } from '@prisma/client';
import { documentListQuerySchema } from '../common';

export {
  documentListQuerySchema,
  idParamSchema,
  optionalReasonSchema,
  requiredReasonSchema,
} from '../common';
export type { DocumentListQuery, IdParam } from '../common';

/** Document register: the shared document filters plus the type discriminator. */
export const documentRegisterQuerySchema = documentListQuerySchema.extend({
  documentType: z.nativeEnum(DocumentType).optional(),
});
export type DocumentRegisterQuery = z.infer<typeof documentRegisterQuerySchema>;
