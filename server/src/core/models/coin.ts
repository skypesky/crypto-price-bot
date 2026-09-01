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
  alert_above: number | null;
  alert_below: number | null;
  last_price: number | null;
  last_alert_at: number;
  last_alert_dir: 'above' | 'below' | null;
  created_at: number;
  updated_at: number;
}

const COIN_COLS = `id, symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled,
  alert_above, alert_below, last_price, last_alert_at, last_alert_dir, created_at, updated_at`;

export const DEFAULT_COINS: Array<Omit<Coin, 'id' | 'created_at' | 'updated_at' | 'last_alert_at' | 'last_price' | 'last_alert_dir'>> = [
  { symbol: 'BTC',  name: '比特币',   gate_pair: 'BTC_USDT',  gate_slug: 'bitcoin',     cg_id: 'bitcoin',         sort_order: 0,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'ETH',  name: '以太坊',   gate_pair: 'ETH_USDT',  gate_slug: 'ethereum',    cg_id: 'ethereum',        sort_order: 1,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'USDT', name: '泰达币',   gate_pair: null,        gate_slug: 'tether',      cg_id: 'tether',          sort_order: 2,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'SOL',  name: '索拉纳',   gate_pair: 'SOL_USDT',  gate_slug: 'solana',      cg_id: 'solana',          sort_order: 3,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'ABT',  name: '区块基石', gate_pair: 'ABT_USDT',  gate_slug: 'arcblock',    cg_id: 'arcblock',        sort_order: 4,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'BNB',  name: '币安币',   gate_pair: 'BNB_USDT',  gate_slug: 'bnb',         cg_id: 'binancecoin',     sort_order: 5,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'FIL',  name: '文件币',   gate_pair: 'FIL_USDT',  gate_slug: 'filecoinipfs',cg_id: 'filecoin',        sort_order: 6,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'ATOM', name: '阿童木',   gate_pair: 'ATOM_USDT', gate_slug: 'cosmos-hub',  cg_id: 'cosmos',          sort_order: 7,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'OP',   name: 'Optimism', gate_pair: 'OP_USDT',   gate_slug: 'optimism',    cg_id: 'optimism',        sort_order: 8,  enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'GT',   name: 'Gate',    gate_pair: 'GT_USDT',   gate_slug: 'gate',        cg_id: 'gatechain-token', sort_order: 9, enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'YGG',  name: 'Yield Guild Games', gate_pair: 'YGG_USDT',  gate_slug: 'yieldguildgames', cg_id: 'yield-guild-games', sort_order: 10, enabled: 1, alert_above: null, alert_below: null },
  { symbol: 'SAGA', name: 'Saga',              gate_pair: 'SAGA_USDT', gate_slug: 'saga',            cg_id: 'saga-2',            sort_order: 11, enabled: 1, alert_above: null, alert_below: null },
];

export function initDefaultCoins(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM coins').get() as { c: number }).c;
  if (count > 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO coins (symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled,
       alert_above, alert_below, last_alert_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const tx = db.transaction((rows: typeof DEFAULT_COINS) => {
    for (const c of rows) {
      stmt.run(c.symbol, c.name, c.gate_pair, c.gate_slug, c.cg_id, c.sort_order, c.enabled,
        c.alert_above, c.alert_below, now, now);
    }
  });
  tx(DEFAULT_COINS);
}

export function listCoins(): Coin[] {
  return getDb().prepare(`SELECT ${COIN_COLS} FROM coins ORDER BY sort_order ASC, id ASC`).all() as Coin[];
}

export function listEnabledCoins(): Coin[] {
  return getDb().prepare(`SELECT ${COIN_COLS} FROM coins WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`).all() as Coin[];
}

export function findCoinById(id: number): Coin | null {
  const row = getDb().prepare(`SELECT ${COIN_COLS} FROM coins WHERE id = ?`).get(id) as Coin | undefined;
  return row ?? null;
}

export function createCoin(input: Omit<Coin, 'id' | 'created_at' | 'updated_at' | 'last_alert_at' | 'last_price' | 'last_alert_dir'>): Coin {
  const now = Date.now();
  const info = getDb().prepare(
    `INSERT INTO coins (symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled,
       alert_above, alert_below, last_alert_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(input.symbol, input.name, input.gate_pair, input.gate_slug, input.cg_id, input.sort_order, input.enabled,
       input.alert_above, input.alert_below, now, now);
  return findCoinById(Number(info.lastInsertRowid))!;
}

export function updateCoin(id: number, patch: Partial<Omit<Coin, 'id' | 'created_at' | 'updated_at'>>): Coin | null {
  const cur = findCoinById(id);
  if (!cur) return null;
  const merged = { ...cur, ...patch, updated_at: Date.now() };
  getDb().prepare(
    `UPDATE coins SET symbol=?, name=?, gate_pair=?, gate_slug=?, cg_id=?, sort_order=?, enabled=?,
        alert_above=?, alert_below=?, last_price=?, last_alert_at=?, last_alert_dir=?, updated_at=?
     WHERE id=?`,
  ).run(merged.symbol, merged.name, merged.gate_pair, merged.gate_slug, merged.cg_id, merged.sort_order, merged.enabled,
        merged.alert_above, merged.alert_below, merged.last_price, merged.last_alert_at, merged.last_alert_dir,
        merged.updated_at, id);
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
