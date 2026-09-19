import { AuthContext } from '../context/authContext';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      validatedQuery?: unknown;
      validatedParams?: unknown;
    }
  }
}

export {};
