import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { logger } from '../loggers';
import { AuthContext } from '../context/authContext';
import { authContextFromAccessToken } from '../context/resolveIdentity';
import { SOCKET_PATH } from '../constants/notifications';
import { resolveScopedBranchIds } from '../services/authorization.service';

/** Rooms are named by the server alone; a client never asks to join one. */
export const room = {
  user: (userId: string) => `user:${userId}`,
  company: (companyId: string) => `company:${companyId}`,
  branch: (branchId: string) => `branch:${branchId}`,
};

interface SocketData {
  auth: AuthContext;
}

let io: SocketIOServer | null = null;

/**
 * Reads the access token off the handshake. `auth.token` is the Socket.IO idiom;
 * the Authorization header is accepted too so a proxy that already sets it works.
 * Nothing else on the handshake is read - identity comes from the token alone.
 */
function tokenFromHandshake(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim()) {
    return fromAuth.trim();
  }
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}

/**
 * Attaches the realtime gateway to the existing Express HTTP server - there is no
 * second port and no second process.
 *
 * Every connection is authenticated with the same token verification and database
 * re-read the REST API uses, then the server puts the socket into exactly the
 * rooms that identity allows: its own user room, its company room, and one room
 * per branch already in its scope. A Branch A user therefore cannot subscribe to
 * Branch B traffic, because it is the server that decides membership.
 */
export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    path: SOCKET_PATH,
    cors: { origin: '*' },
    // Matches the JSON body ceiling; notification payloads are far smaller.
    maxHttpBufferSize: 1_000_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = tokenFromHandshake(socket);
      if (!token) {
        return next(new Error('unauthorized'));
      }
      (socket.data as SocketData).auth = await authContextFromAccessToken(token);
      next();
    } catch {
      // The client is told only that it was refused: never why.
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    void (async () => {
      const auth = (socket.data as SocketData).auth;
      try {
        const branchIds = await resolveScopedBranchIds(auth);
        await socket.join([
          room.user(auth.userId),
          room.company(auth.companyId),
          ...branchIds.map(room.branch),
        ]);
        logger.info('Socket connected', {
          userId: auth.userId,
          companyId: auth.companyId,
          branches: branchIds.length,
        });
      } catch (error) {
        logger.warn('Socket room setup failed', {
          userId: auth.userId,
          reason: error instanceof Error ? error.message : String(error),
        });
        socket.disconnect(true);
      }
    })();

    socket.on('disconnect', (reason) => {
      logger.info('Socket disconnected', {
        userId: (socket.data as SocketData).auth?.userId,
        reason,
      });
    });
  });

  logger.info('Realtime gateway ready', { path: SOCKET_PATH });
  return io;
}

/** Null until the HTTP server has started, so emitters must tolerate no gateway. */
export function getSocketServer(): SocketIOServer | null {
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (!io) {
    return;
  }
  const current = io;
  io = null;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
