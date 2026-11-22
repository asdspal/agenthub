// Server-side token minting — the ONLY module that reads NEXCONN_API_SECRET.
import { mintToken } from './client';

export async function mintUserToken(userId: string, displayName?: string): Promise<string> {
  return mintToken(userId, displayName ?? userId);
}
