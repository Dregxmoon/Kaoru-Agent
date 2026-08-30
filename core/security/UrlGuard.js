'use strict';

/**
 * UrlGuard.js — validación de URLs para tools de red (webfetch, browser).
 *
 * Evita que el LLM (por error, prompt injection o alucinación) apunte tools
 * de red a IPs internas, loopback, link-local o el propio Control API.
 * Se aplica como defensa en capas: ANTES de cada request HTTP y en cada
 * hop de redirect.
 */

const dns = require('dns');

// ── Control API port (configurable) ──────────────────────────────────────────
let _controlApiPort = 3131;
function setControlApiPort(port) {
  _controlApiPort = port;
}

// ── IPv4 range checks ────────────────────────────────────────────────────────

function _ipv4ToNum(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function _isInIPv4Cidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
  const ipNum = _ipv4ToNum(ip);
  const rangeNum = _ipv4ToNum(range);
  if (ipNum === null || rangeNum === null) return false;
  return (ipNum & mask) === (rangeNum & mask);
}

// ── IPv6 helpers ─────────────────────────────────────────────────────────────

function _expandIPv6(ipv6) {
  let addr = ipv6.split('%')[0];
  if (addr.includes('::')) {
    const halves = addr.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    addr = [...left, ...Array(missing).fill('0000'), ...right].join(':');
  }
  const groups = addr.split(':');
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

function _isInIPv6Cidr(ipv6, prefix) {
  const [range, bits] = prefix.split('/');
  const expandedIp = _expandIPv6(ipv6);
  const expandedRange = _expandIPv6(range);
  if (!expandedIp || !expandedRange) return false;
  // Convert hex to binary string (128 chars) for proper bit-level comparison
  const ipBin = expandedIp
    .split('')
    .map((c) => parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
  const rangeBin = expandedRange
    .split('')
    .map((c) => parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
  const maskBits = parseInt(bits, 10);
  return ipBin.slice(0, maskBits) === rangeBin.slice(0, maskBits);
}

// ── Blocked ranges ───────────────────────────────────────────────────────────

const BLOCKED_IPV4_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '100.64.0.0/10',
  '224.0.0.0/4',
];

const BLOCKED_IPV6_CIDRS = ['::1/128', 'fc00::/7', 'fe80::/10', '::ffff:0:0/96'];

const BLOCKED_HOSTNAMES = ['localhost'];

// ── IP check helpers ─────────────────────────────────────────────────────────

function _isBlockedIPv4(ip) {
  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if (_isInIPv4Cidr(ip, cidr)) return true;
  }
  return false;
}

function _isBlockedIPv6(ip) {
  for (const cidr of BLOCKED_IPV6_CIDRS) {
    if (_isInIPv6Cidr(ip, cidr)) return true;
  }
  return false;
}

function _isBlockedIp(ip) {
  return _isBlockedIPv4(ip) || _isBlockedIPv6(ip);
}

// ── Resolve hostname to IP ───────────────────────────────────────────────────

function _resolveHost(hostname, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      if (err || !addresses || addresses.length === 0) {
        resolve(null);
        return;
      }
      resolve(addresses);
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Valida si una URL es segura para hacer fetch/navegación.
 * Resuelve el hostname a IP y verifica que no caiga en rangos
 * privados, loopback, link-local o multicast.
 * @param {string} urlString
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ safe: boolean, reason?: string }>}
 */
async function isUrlSafe(urlString, opts = {}) {
  const timeout = opts.timeout ?? 3000;

  // 1. Parsear URL
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'URL malformada' };
  }

  // 2. Protocolo http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Protocolo no permitido: ' + parsed.protocol };
  }

  const hostname = parsed.hostname;

  // 3. Rechazar hostnames bloqueados
  if (BLOCKED_HOSTNAMES.includes(hostname.toLowerCase())) {
    return { safe: false, reason: 'Hostname bloqueado: ' + hostname };
  }

  // 4. Si el hostname es una IP directa, verificar sin DNS
  if (require('net').isIPv4(hostname)) {
    if (_isBlockedIPv4(hostname)) {
      return { safe: false, reason: 'IP en rango bloqueado: ' + hostname };
    }
    // Verificar Control API port
    if (hostname === '127.0.0.1' && String(parsed.port || '80') === String(_controlApiPort)) {
      return {
        safe: false,
        reason: 'Control API local bloqueada (127.0.0.1:' + _controlApiPort + ')',
      };
    }
    return { safe: true };
  }
  if (require('net').isIPv6(hostname)) {
    if (_isBlockedIPv6(hostname)) {
      return { safe: false, reason: 'IPv6 en rango bloqueado: ' + hostname };
    }
    return { safe: true };
  }

  // 5. Resolver hostname a IP(s)
  const addresses = await _resolveHost(hostname, timeout);
  if (!addresses) {
    return { safe: false, reason: 'No se pudo resolver DNS para: ' + hostname };
  }

  for (const addr of addresses) {
    const ip = addr.address;
    const isV6 = addr.family === 6;

    if (isV6 ? _isBlockedIPv6(ip) : _isBlockedIPv4(ip)) {
      return { safe: false, reason: 'IP en rango bloqueado: ' + hostname + ' -> ' + ip };
    }

    // Control API local: 127.0.0.1 o ::1 en el puerto del Control API
    const port = String(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
    if (port === String(_controlApiPort)) {
      if (!isV6 && _isInIPv4Cidr(ip, '127.0.0.0/8')) {
        return { safe: false, reason: 'Control API local bloqueada (' + ip + ':' + port + ')' };
      }
      if (isV6 && ip === '::1') {
        return { safe: false, reason: 'Control API local bloqueada (::1:' + port + ')' };
      }
    }
  }

  return { safe: true };
}

module.exports = { isUrlSafe, setControlApiPort, _isBlockedIPv4, _isBlockedIPv6, _expandIPv6 };
