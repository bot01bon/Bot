import axios from 'axios';
import { filterTokensByStrategy } from './bot/strategy';
import { normalizeStrategy } from './utils/strategyNormalizer';
import { registerBuyWithTarget } from './bot/strategy';
import { extractTradeMeta } from './utils/tradeMeta';
import { unifiedBuy } from './tradeSources';
import { fetchDexScreenerTokens, fetchSolanaFromCoinGecko } from './utils/tokenUtils';
import { JUPITER_QUOTE_API } from './config';
import { getCoinData as getPumpData } from './pump/api';
import { existsSync, mkdirSync } from 'fs';
import fs from 'fs';
const fsp = fs.promises;
import { saveUsers, writeJsonFile } from './bot/helpers';
import path from 'path';

type UsersMap = Record<string, any>;

const DEXBOOSTS = process.env.DEXSCREENER_API_ENDPOINT || 'https://api.dexscreener.com/token-boosts/latest/v1';

export function hashTokenAddress(addr: string) {
  return String(addr || '').toLowerCase().trim();
}

async function ensureSentDir() {
  const sent = path.join(process.cwd(), 'sent_tokens');
  try {
    await fsp.mkdir(sent, { recursive: true });
  } catch {}
  return sent;
}

export async function readSentHashes(userId: string): Promise<Set<string>> {
  try {
  const sentDir = await ensureSentDir();
    const file = path.join(sentDir, `${userId}.json`);
    const stat = await fsp.stat(file).catch(() => false);
    if (!stat) return new Set();
    const data = JSON.parse(await fsp.readFile(file, 'utf8')) as any[];
    return new Set((data || []).map(d => d.hash).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

export async function appendSentHash(userId: string, hash: string) {
  try {
  const sentDir = await ensureSentDir();
    const file = path.join(sentDir, `${userId}.json`);
    let arr: any[] = [];
    try {
      const stat = await fsp.stat(file).catch(() => false);
      if (stat) {
        arr = JSON.parse(await fsp.readFile(file, 'utf8')) || [];
      }
    } catch {}
    arr.push({ hash, time: Date.now() });
    // write atomically via helper queue
    await writeJsonFile(file, arr.slice(-500)).catch(() => {});
  } catch (e) {}
}

/**
 * Start fast polling of DexScreener boosts endpoint and prioritize users flagged in their strategy.
 * Prioritized users: user.strategy.priority === true or user.strategy.priorityRank > 0
 */
export function startFastTokenFetcher(users: UsersMap, telegram: any, options?: { intervalMs?: number }) {
  const intervalMs = options?.intervalMs || 1000;
  const perUserLimit = (options as any)?.perUserLimit || 1; // max messages per interval
  const batchLimit = (options as any)?.batchLimit || 20; // tokens per user per interval
  let running = true;

  const lastSent: Map<string, number> = new Map();

  async function loop() {
    while (running) {
      try {
        // Fetch & filter tokens for all users using shared cache
        const perUserTokens = await fetchAndFilterTokensForUsers(users, { limit: 200, force: false });

        // Build prioritized list ordered by priorityRank desc then priority boolean
        const priorityUsers = Object.keys(users)
          .filter(uid => {
            const u = users[uid];
            return u && u.strategy && (u.strategy.priority === true || (u.strategy.priorityRank && u.strategy.priorityRank > 0));
          })
          .sort((a, b) => ( (users[b].strategy?.priorityRank || 0) - (users[a].strategy?.priorityRank || 0) ));

        // First process priority users, then regular users
        const processOrder = [...priorityUsers, ...Object.keys(users).filter(u => !priorityUsers.includes(u))];

        for (const uid of processOrder) {
          try {
            const u = users[uid];
            if (!u || !u.strategy || u.strategy.enabled === false) continue;
            const matches = perUserTokens[uid] || [];
            if (!matches.length) continue;

            // rate limiting: allow perUserLimit messages per interval
            const last = lastSent.get(uid) || 0;
            if (Date.now() - last < intervalMs * (perUserLimit)) {
              // skip this user this iteration
              continue;
            }

            // limit tokens per user per interval
            const tokensToSend = matches.slice(0, batchLimit);

            // Filter out tokens already sent (sent hashes)
            const sent = await readSentHashes(uid);
            const filtered = tokensToSend.filter(t => {
              const addr = t.tokenAddress || t.address || t.mint || t.pairAddress || '';
              const h = hashTokenAddress(addr);
              return addr && !sent.has(h);
            });
            if (!filtered.length) continue;

            // Send notifications in a batch (one message with multiple tokens or multiple messages)
            for (const token of filtered) {
              const addr = token.tokenAddress || token.address || token.mint || token.pairAddress || '';
              const h = hashTokenAddress(addr);
              try {
                const msg = `🚀 Token matched: ${token.description || token.name || addr}\nAddress: ${addr}`;
                await telegram.sendMessage(uid, msg);
                await appendSentHash(uid, h);
              } catch (e) {
                // ignore send errors per token
              }
            }

            // Optionally auto-buy for users with autoBuy enabled
            if (u.strategy.autoBuy !== false && Number(u.strategy.buyAmount) > 0) {
                    for (const token of filtered) {
                const addr = token.tokenAddress || token.address || token.mint || token.pairAddress || '';
                try {
                  const finalStrategy = normalizeStrategy(u.strategy);
                  const finalOk = await (require('./bot/strategy').filterTokensByStrategy([token], finalStrategy));
                  if (!finalOk || finalOk.length === 0) continue;
                  const amount = Number(u.strategy.buyAmount);
                  const result = await unifiedBuy(addr, amount, u.secret);
                  if (result && ((result as any).tx || (result as any).success)) {
                    try { await registerBuyWithTarget(u, { address: addr, price: token.price || token.priceUsd }, result, u.strategy.targetPercent || 10); } catch {}
                    const { fee, slippage } = extractTradeMeta(result, 'buy');
                    u.history = u.history || [];
                    const resTx = (result as any)?.tx ?? '';
                    u.history.push(`AutoBuy: ${addr} | ${amount} SOL | Tx: ${resTx} | Fee: ${fee ?? 'N/A'} | Slippage: ${slippage ?? 'N/A'}`);
                    try { saveUsers(users); } catch {}
                    // notify user about executed buy
                    try { await telegram.sendMessage(uid, `✅ AutoBuy executed for ${addr}\nTx: ${resTx}`); } catch {}
                    }
                } catch (e) {
                  // ignore per-token buy errors
                }
              }
            }

            lastSent.set(uid, Date.now());
          } catch (e) {
            // per-user loop error: continue
            continue;
          }
        }

      } catch (err) {
        // ignore fetch loop errors
      }
      await sleep(intervalMs);
    }
  }

  loop();

  return {
    stop: () => { running = false; }
  };
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

// =========================
// New: fetch and filter tokens per-user
// =========================
let __global_fetch_cache: any[] = [];
let __global_fetch_ts = 0;
const __GLOBAL_FETCH_TTL = 1000 * 60 * 1; // 1 minute default

/**
 * Fetch tokens from common sources (DexScreener, CoinGecko fallback) once,
 * then filter tokens per user based on their normalized strategy.
 * Returns a map: { [userId]: tokens[] }
 */
export async function fetchAndFilterTokensForUsers(users: UsersMap, opts?: { limit?: number, force?: boolean }): Promise<Record<string, any[]>> {
  const now = Date.now();
  if (!opts?.force && __global_fetch_cache.length && (now - __global_fetch_ts) < __GLOBAL_FETCH_TTL) {
    // use cache
  } else {
    try {
      const limit = opts?.limit || 200;
  // fetch unified tokens (DexScreener + Solana RPC + Jupiter enrichment)
  const { fetchUnifiedTokens } = require('./utils/tokenUtils');
  __global_fetch_cache = await fetchUnifiedTokens('solana', { limit: String(limit) } as any);
      __global_fetch_ts = Date.now();
    } catch (e) {
      // fallback: try coinGecko single fetch
      try {
        const cg = await fetchSolanaFromCoinGecko();
        __global_fetch_cache = cg ? [cg] : [];
        __global_fetch_ts = Date.now();
      } catch {
        __global_fetch_cache = [];
      }
    }
  }

  const result: Record<string, any[]> = {};
  const normalizedMap: Record<string, any> = {};
  // pre-normalize strategies
  for (const uid of Object.keys(users)) {
    const u = users[uid];
    if (!u || !u.strategy) continue;
    try {
      normalizedMap[uid] = normalizeStrategy(u.strategy);
    } catch {
      normalizedMap[uid] = u.strategy;
    }
  }

  // For each user, filter tokens using filterTokensByStrategy (robust)
  for (const uid of Object.keys(normalizedMap)) {
    const strat = normalizedMap[uid];
    if (!strat || strat.enabled === false) {
      result[uid] = [];
      continue;
    }
    try {
      // Official enrichment: for safety, check a small sample using Solana RPC + Jupiter.
      // We do this when user has autoBuy enabled or buyAmount > 0 to avoid unnecessary calls.
      const needOfficial = (typeof strat.buyAmount === 'number' && strat.buyAmount > 0) || strat.autoBuy !== false;
      let workCache = __global_fetch_cache;
      if (needOfficial && Array.isArray(workCache) && workCache.length > 0) {
        const sampleSize = 200;
        const sample = workCache.slice(0, sampleSize);
        const { officialEnrich } = require('./utils/tokenUtils');
        const concurrency = 5;
        let idx = 0;
        async function worker() {
          while (idx < sample.length) {
            const i = idx++;
            const t = sample[i];
            try { await officialEnrich(t, { amountUsd: Number(strat.buyAmount) || 50, timeoutMs: 4000 }); } catch (e) {}
          }
        }
        const workers = Array.from({ length: Math.min(concurrency, sample.length) }, () => worker());
        const globalTimeoutMs = 10000;
        await Promise.race([ Promise.all(workers), new Promise(res => setTimeout(res, globalTimeoutMs)) ]);
        workCache = [...sample, ...workCache.slice(sampleSize)];
      }
  const matches = await (require('./bot/strategy').filterTokensByStrategy(workCache, strat));
  result[uid] = Array.isArray(matches) ? matches : [];
    } catch (e) {
      result[uid] = [];
    }
  }

  return result;
}
