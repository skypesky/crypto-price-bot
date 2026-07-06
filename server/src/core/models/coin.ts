import { getDb } from '../db.js';

export interface Coin {
  id: number;
  symbol: string;
  name: string;
  gate_pair: string | null;
  gate_slug: string | null;
  cg_id: string;
  sort_order: number;
  enabled: number; // 0/1
  created_at: number;
  updated_at: number;
}

export const DEFAULT_COINS: Array<Omit<Coin, 'id' | 'created_at' | 'updated_at'>> = [
  { symbol: 'BTC',  name: '比特币',   gate_pair: 'BTC_USDT',  gate_slug: 'bitcoin',     cg_id: 'bitcoin',         sort_order: 0,  enabled: 1 },
  { symbol: 'ETH',  name: '以太坊',   gate_pair: 'ETH_USDT',  gate_slug: 'ethereum',    cg_id: 'ethereum',        sort_order: 1,  enabled: 1 },
  { symbol: 'USDT', name: '泰达币',   gate_pair: null,        gate_slug: 'tether',      cg_id: 'tether',          sort_order: 2,  enabled: 1 },
  { symbol: 'SOL',  name: '索拉纳',   gate_pair: 'SOL_USDT',  gate_slug: 'solana',      cg_id: 'solana',          sort_order: 3,  enabled: 1 },
  { symbol: 'ABT',  name: '区块基石', gate_pair: 'ABT_USDT',  gate_slug: 'arcblock',    cg_id: 'arcblock',        sort_order: 4,  enabled: 1 },
  { symbol: 'BNB',  name: '币安币',   gate_pair: 'BNB_USDT',  gate_slug: 'bnb',         cg_id: 'binancecoin',     sort_order: 5,  enabled: 1 },
  { symbol: 'ICX',  name: 'ICON',    gate_pair: 'ICX_USDT',  gate_slug: 'icon',        cg_id: 'icon',            sort_order: 6,  enabled: 1 },
  { symbol: 'FIL',  name: '文件币',   gate_pair: 'FIL_USDT',  gate_slug: 'filecoinipfs',cg_id: 'filecoin',        sort_order: 7,  enabled: 1 },
  { symbol: 'ATOM', name: '阿童木',   gate_pair: 'ATOM_USDT', gate_slug: 'cosmos-hub',  cg_id: 'cosmos',          sort_order: 8,  enabled: 1 },
  { symbol: 'OP',   name: 'Optimism', gate_pair: 'OP_USDT',   gate_slug: 'optimism',    cg_id: 'optimism',        sort_order: 9,  enabled: 1 },
  { symbol: 'GT',   name: 'Gate',    gate_pair: 'GT_USDT',   gate_slug: 'gate',        cg_id: 'gatechain-token', sort_order: 10, enabled: 1 },
  { symbol: 'YGG',  name: 'Yield Guild Games', gate_pair: 'YGG_USDT',  gate_slug: 'yieldguildgames', cg_id: 'yield-guild-games', sort_order: 11, enabled: 1 },
  { symbol: 'SAGA', name: 'Saga',              gate_pair: 'SAGA_USDT', gate_slug: 'saga',            cg_id: 'saga-2',            sort_order: 12, enabled: 1 },
];

export function initDefaultCoins(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM coins').get() as { c: number }).c;
  if (count > 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    'INSERT INTO coins (symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const tx = db.transaction((rows: typeof DEFAULT_COINS) => {
    for (const c of rows) {
      stmt.run(c.symbol, c.name, c.gate_pair, c.gate_slug, c.cg_id, c.sort_order, c.enabled, now, now);
    }
  });
  tx(DEFAULT_COINS);
}

export function listCoins(): Coin[] {
  return getDb().prepare('SELECT * FROM coins ORDER BY sort_order ASC, id ASC').all() as Coin[];
}

export function listEnabledCoins(): Coin[] {
  return getDb().prepare('SELECT * FROM coins WHERE enabled = 1 ORDER BY sort_order ASC, id ASC').all() as Coin[];
}

export function findCoinById(id: number): Coin | null {
  const row = getDb().prepare('SELECT * FROM coins WHERE id = ?').get(id) as Coin | undefined;
  return row ?? null;
}

export function createCoin(input: Omit<Coin, 'id' | 'created_at' | 'updated_at'>): Coin {
  const now = Date.now();
  const info = getDb().prepare(
    'INSERT INTO coins (symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.symbol, input.name, input.gate_pair, input.gate_slug, input.cg_id, input.sort_order, input.enabled, now, now);
  return findCoinById(Number(info.lastInsertRowid))!;
}

export function updateCoin(id: number, patch: Partial<Omit<Coin, 'id' | 'created_at' | 'updated_at'>>): Coin | null {
  const cur = findCoinById(id);
  if (!cur) return null;
  const merged = { ...cur, ...patch, updated_at: Date.now() };
  getDb().prepare(
    'UPDATE coins SET symbol=?, name=?, gate_pair=?, gate_slug=?, cg_id=?, sort_order=?, enabled=?, updated_at=? WHERE id=?',
  ).run(merged.symbol, merged.name, merged.gate_pair, merged.gate_slug, merged.cg_id, merged.sort_order, merged.enabled, merged.updated_at, id);
  return findCoinById(id);
}

export function deleteCoin(id: number): boolean {
  const info = getDb().prepare('DELETE FROM coins WHERE id = ?').run(id);
  return info.changes > 0;
}

export function reorderCoins(ids: number[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE coins SET sort_order = ?, updated_at = ? WHERE id = ?');
  const tx = db.transaction((rows: number[]) => {
    const now = Date.now();
    rows.forEach((id, idx) => stmt.run(idx, now, id));
  });
  tx(ids);
}