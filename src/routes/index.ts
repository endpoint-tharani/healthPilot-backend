import { Router } from 'express';
import { authenticateUser } from '../middleware/authenticateUser';

import authRoutes from './auth.routes';
import branchRoutes from './branch.routes';
import creditNoteRoutes from './creditNote.routes';
import dispensingRoutes from './dispensing.routes';
import documentRoutes from './document.routes';
import goodsReceiptRoutes from './goodsReceipt.routes';
import inventoryRoutes from './inventory.routes';
import notificationRoutes from './notification.routes';
import paymentRoutes from './payment.routes';
import productRoutes from './product.routes';
import purchaseOrderRoutes from './purchaseOrder.routes';
import receiptCorrectionRoutes from './receiptCorrection.routes';
import stockRequirementRoutes from './stockRequirement.routes';
import stockTransferRoutes from './stockTransfer.routes';
import supplierRoutes from './supplier.routes';
import supplierInvoiceRoutes from './supplierInvoice.routes';
import userRoutes from './user.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRoutes);

// Everything below requires a verified access token; company and branch scope is
// then enforced per service.
apiRouter.use(authenticateUser);

apiRouter.use('/branches', branchRoutes);
apiRouter.use('/products', productRoutes);
apiRouter.use('/suppliers', supplierRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/stock-requirements', stockRequirementRoutes);
apiRouter.use('/purchase-orders', purchaseOrderRoutes);
apiRouter.use('/goods-receipts', goodsReceiptRoutes);
apiRouter.use('/receipt-corrections', receiptCorrectionRoutes);
apiRouter.use('/supplier-invoices', supplierInvoiceRoutes);
apiRouter.use('/credit-notes', creditNoteRoutes);
apiRouter.use('/payments', paymentRoutes);
apiRouter.use('/stock-transfers', stockTransferRoutes);
apiRouter.use('/dispensing', dispensingRoutes);
apiRouter.use('/inventory', inventoryRoutes);
apiRouter.use('/documents', documentRoutes);
apiRouter.use('/notifications', notificationRoutes);

export default apiRouter;
