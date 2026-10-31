/**
 * 局域网扫描：探测邻居 /hello
 */
import os from 'node:os';
import { HTTP_PORT } from './store.mjs';

function ipv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const item of list || []) {
      if (!item || item.internal) continue;
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      const addr = String(item.address || '');
      const netmask = String(item.netmask || '');
      if (!addr || !netmask) continue;
      if (addr.startsWith('169.254.')) continue;
      out.push({ name, address: addr, netmask });
    }
  }
  return out;
}

function ipToInt(ip) {
  const p = String(ip).split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function subnetHosts(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  if (ip == null || mask == null) return [];
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  const start = network + 1;
  const end = broadcast - 1;
  let count = 0;
  for (let i = start; i <= end && count < 254; i++) {
    const host = intToIp(i >>> 0);
    if (host === address) continue;
    hosts.push(host);
    count += 1;
  }
  return hosts;
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function probeHello(host, port, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/hello`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.clientId || data.app !== 'lan-mesh-chat') return null;
    return {
      host,
      httpPort: port,
      wsPort: Number(data.wsPort) || 17902,
      clientId: String(data.clientId),
      name: String(data.name || ''),
      groups: Array.isArray(data.groups) ? data.groups : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   port?: number,
 *   extraPorts?: number[],
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   includeLocalhost?: boolean,
 * }} [opts]
 */
export async function scanPeers(opts = {}) {
  const primaryPort = opts.port || HTTP_PORT;
  const extraPorts = [...new Set([...(opts.extraPorts || []).map(Number).filter((n) => n > 0)])];
  const ports = [...new Set([primaryPort, ...extraPorts])];
  const timeoutMs = opts.timeoutMs ?? 350;
  const concurrency = opts.concurrency ?? 40;
  const ifaces = ipv4Interfaces();
  const hostSet = new Set();
  for (const iface of ifaces) {
    for (const h of subnetHosts(iface.address, iface.netmask)) hostSet.add(h);
  }
  if (opts.includeLocalhost !== false) {
    hostSet.add('127.0.0.1');
  }
  const hosts = [...hostSet];
  /** @type {Array<{host:string,port:number}>} */
  const targets = [];
  for (const host of hosts) {
    for (const port of ports) {
      // 跳过扫自己正在监听的端口（同进程）
      if (host === '127.0.0.1' && port === HTTP_PORT) continue;
      targets.push({ host, port });
    }
  }
  const found = [];
  await mapPool(targets, concurrency, async (t) => {
    const hit = await probeHello(t.host, t.port, timeoutMs);
    if (hit) found.push(hit);
  });
  // 按 clientId 去重
  const byId = new Map();
  for (const p of found) {
    if (!byId.has(p.clientId)) byId.set(p.clientId, p);
  }
  const peers = [...byId.values()];
  peers.sort((a, b) => String(a.name || a.clientId).localeCompare(String(b.name || b.clientId), 'zh'));
  return { interfaces: ifaces, scanned: targets.length, peers };
}

export async function invitePeer(host, body, timeoutMs = 8000, httpPort = HTTP_PORT) {
  const port = Number(httpPort) || HTTP_PORT;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/invite`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `邀请失败 HTTP ${res.status}`);
    return data;
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (e?.name === 'AbortError' || /aborted/i.test(msg)) {
      throw new Error('无法联系对方（发送邀请超时）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitInviteDecision(host, inviteId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 1000;
  const port = Number(opts.httpPort) || HTTP_PORT;
  const deadline = Date.now() + timeoutMs;
  const id = String(inviteId || '').trim();
  if (!id) throw new Error('缺少 inviteId');

  while (Date.now() < deadline) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(
        `http://${host}:${port}/invite-status?inviteId=${encodeURIComponent(id)}`,
        { method: 'GET', signal: ctrl.signal, headers: { Accept: 'application/json' } }
      );
      const data = await res.json().catch(() => ({}));
      const status = String(data.status || '');
      if (data.inviteId && data.inviteId !== id) {
        /* ignore */
      } else if (status === 'accepted') {
        return data;
      } else if (status === 'rejected') {
        throw new Error('对方已拒绝入群');
      } else if (status === 'timeout') {
        throw new Error('对方未在时限内确认');
      }
    } catch (e) {
      if (e instanceof Error && /拒绝|时限/.test(e.message)) throw e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('等待对方确认超时');
}
