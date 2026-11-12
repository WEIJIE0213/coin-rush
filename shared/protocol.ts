export type Phase = 'waiting' | 'countdown' | 'playing' | 'finished';
export interface Player { id: string; name: string; score: number; connected: boolean }
export interface Coin { id: string; cell: number; spawnedAt: number; expiresAt: number }
export interface RoomState { code: string; phase: Phase; deadline: number; players: Player[]; coin: Coin | null; round: number; version: number; serverTime: number }
export type ClientMessage =
  | { type: 'join'; code: string; name: string; token?: string }
  | { type: 'hit'; coinId: string; requestId: string }
  | { type: 'sync'; clientTime: number }
  | { type: 'leave' }
  | { type: 'restart' };
export type ServerMessage =
  | { type: 'joined'; playerId: string; token: string; state: RoomState }
  | { type: 'state'; state: RoomState }
  | { type: 'notice'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'sync'; clientTime: number; serverTime: number }
  | { type: 'hit_result'; requestId: string; coinId: string; accepted: boolean; reason: string; state: RoomState };
