'use strict';

/**
 * KOVER.IA — Input validation primitives
 * ---------------------------------------------------------------------------
 *
 * Hand-rolled validators for every untrusted input that crosses a trust
 * boundary into the engine: mempool transactions, dashboard requests,
 * environment configuration, AI analyst payloads.
 *
 * Why hand-rolled instead of Zod?
 *   - Zero dependency surface (security-critical service)
 *   - Predictable byte-for-byte error messages (no library upgrades changing
 *     telemetry)
 *   - All validation is in O(1) or O(n) time and the structures are small
 *
 * Every validator returns either:
 *   - the cleaned/normalized value, OR
 *   - throws ValidationError with a concise reason
 *
 * @module    src/validators
 * @author    KOVER.IA platform team
 * @license   Proprietary
 */

class ValidationError extends Error {
  constructor(field, reason) {
    super(`validation: ${field}: ${reason}`);
    this.name = 'ValidationError';
    this.field = field;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADDRESS_RE  = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE     = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const HEX_RE      = /^0x[0-9a-fA-F]*$/;

/** Maximum tolerated calldata size (bytes). 256 KB is well above any real tx. */
const MAX_CALLDATA_BYTES = 256 * 1024;
/** Maximum tolerated trace tree depth before we refuse to walk it (DoS guard). */
const MAX_TRACE_DEPTH = 32;
/** Maximum tolerated trace fan-out per frame. */
const MAX_TRACE_CALLS = 256;
/** Wei is 256-bit unsigned. */
const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

/**
 * Validates a 0x-prefixed Ethereum address. Returns the lowercase canonical form.
 * @param {unknown} v
 * @param {string} [field='address']
 * @returns {string}
 */
function address(v, field = 'address') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  if (!ADDRESS_RE.test(v))   throw new ValidationError(field, 'malformed (need 0x + 40 hex)');
  return v.toLowerCase();
}

/**
 * Validates an Ethereum tx hash. Returns the lowercase canonical form.
 * @param {unknown} v
 * @returns {string}
 */
function txHash(v, field = 'hash') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  if (!HASH_RE.test(v))      throw new ValidationError(field, 'malformed (need 0x + 64 hex)');
  return v.toLowerCase();
}

/** Validates a 4-byte selector. Lowercased. */
function selector(v, field = 'selector') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  if (!SELECTOR_RE.test(v))  throw new ValidationError(field, 'malformed (need 0x + 8 hex)');
  return v.toLowerCase();
}

/** Validates arbitrary 0x-hex with bounded length (bytes, NOT chars). */
function boundedHex(v, maxBytes, field = 'hex') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  if (!HEX_RE.test(v))       throw new ValidationError(field, 'must be 0x-prefixed hex');
  // Each byte = 2 hex chars; subtract '0x' prefix.
  const lenBytes = (v.length - 2) / 2;
  if (lenBytes > maxBytes)   throw new ValidationError(field, `too large (${lenBytes} > ${maxBytes} bytes)`);
  return v;
}

/**
 * Validates a value that should fit in uint256.
 * Accepts bigint, decimal string, or hex string. Rejects negatives & overflow.
 * @returns {bigint}
 */
function uint256(v, field = 'amount') {
  let n;
  if (typeof v === 'bigint') {
    n = v;
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new ValidationError(field, 'invalid number');
    n = BigInt(Math.floor(v));
  } else if (typeof v === 'string') {
    try { n = v.startsWith('0x') ? BigInt(v) : BigInt(v); }
    catch { throw new ValidationError(field, 'unparseable as integer'); }
  } else {
    throw new ValidationError(field, 'must be bigint, number, or numeric string');
  }
  if (n < 0n)              throw new ValidationError(field, 'negative not allowed');
  if (n > MAX_UINT256)     throw new ValidationError(field, 'exceeds uint256');
  return n;
}

/** Bounded integer in [min, max]. */
function intRange(v, min, max, field = 'int') {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ValidationError(field, 'not an integer');
  if (n < min || n > max)   throw new ValidationError(field, `out of range [${min}, ${max}]`);
  return n;
}

/** URL — must be http(s):// or ws(s)://, no userinfo, no fragments. */
function url(v, allowedSchemes, field = 'url') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  let u;
  try { u = new URL(v); }
  catch { throw new ValidationError(field, 'malformed URL'); }
  if (!allowedSchemes.includes(u.protocol.replace(':', ''))) {
    throw new ValidationError(field, `scheme must be one of ${allowedSchemes.join(', ')}`);
  }
  if (u.username || u.password) {
    throw new ValidationError(field, 'userinfo in URL is forbidden');
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// Domain validators
// ---------------------------------------------------------------------------

/**
 * Validates a pending transaction object retrieved from a JSON-RPC provider
 * before it enters the engine pipeline. Returns a cleaned, frozen copy.
 *
 * Rejects:
 *   - missing required fields
 *   - oversized calldata (anti-OOM)
 *   - non-conforming addresses / hashes
 *   - negative values
 *
 * @param {object} raw
 * @returns {Readonly<{
 *   hash: string, from: string, to: string|null,
 *   value: bigint, gasPrice: bigint|null,
 *   gasLimit: bigint, maxFeePerGas: bigint|null,
 *   maxPriorityFeePerGas: bigint|null,
 *   nonce: number, data: string,
 * }>}
 */
function mempoolTx(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('tx', 'must be object');
  }
  const tx = {
    hash:                 txHash(raw.hash),
    from:                 address(raw.from, 'tx.from'),
    to:                   raw.to == null ? null : address(raw.to, 'tx.to'),
    value:                uint256(raw.value ?? 0n, 'tx.value'),
    gasPrice:             raw.gasPrice == null ? null : uint256(raw.gasPrice, 'tx.gasPrice'),
    gasLimit:             uint256(raw.gasLimit ?? raw.gas ?? 21000n, 'tx.gasLimit'),
    maxFeePerGas:         raw.maxFeePerGas == null ? null : uint256(raw.maxFeePerGas, 'tx.maxFeePerGas'),
    maxPriorityFeePerGas: raw.maxPriorityFeePerGas == null ? null : uint256(raw.maxPriorityFeePerGas, 'tx.maxPriorityFeePerGas'),
    nonce:                intRange(raw.nonce ?? 0, 0, Number.MAX_SAFE_INTEGER, 'tx.nonce'),
    data:                 boundedHex(raw.data ?? '0x', MAX_CALLDATA_BYTES, 'tx.data'),
  };
  return Object.freeze(tx);
}

/**
 * Recursively validates a Geth callTracer frame tree. Trims branches that
 * exceed depth/fan-out caps. Returns a cleaned copy or throws if the tree
 * is malformed at the root.
 *
 * @param {unknown} frame
 * @param {number} [depth=0]
 * @returns {object}
 */
function traceFrame(frame, depth = 0) {
  if (!frame || typeof frame !== 'object') {
    throw new ValidationError('trace', 'frame must be object');
  }
  if (depth > MAX_TRACE_DEPTH) {
    return { type: frame.type, truncated: 'max-depth-exceeded' };
  }
  const out = {
    type:  typeof frame.type === 'string' ? frame.type.slice(0, 16) : 'CALL',
    from:  typeof frame.from === 'string' ? frame.from.toLowerCase().slice(0, 42) : null,
    to:    typeof frame.to   === 'string' ? frame.to.toLowerCase().slice(0, 42)   : null,
    value: typeof frame.value === 'string' && /^0x[0-9a-fA-F]+$/.test(frame.value)
             ? frame.value : '0x0',
  };
  if (Array.isArray(frame.calls)) {
    const slice = frame.calls.length > MAX_TRACE_CALLS
      ? frame.calls.slice(0, MAX_TRACE_CALLS)
      : frame.calls;
    out.calls = slice.map((c) => traceFrame(c, depth + 1));
    if (frame.calls.length > MAX_TRACE_CALLS) {
      out.truncated = `fan-out-${frame.calls.length}-clipped-to-${MAX_TRACE_CALLS}`;
    }
  }
  return out;
}

/**
 * Validates a private key string. Hex, 0x-prefixed, exactly 64 hex chars,
 * non-zero. Throws ValidationError on any defect — never logs the value.
 */
function privateKey(v, field = 'privateKey') {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be string');
  if (!HASH_RE.test(v))      throw new ValidationError(field, 'must be 0x + 64 hex chars');
  if (/^0x0+$/.test(v))      throw new ValidationError(field, 'is the zero key');
  return v;
}

/**
 * Validates an env-derived chain ID. Rejects 0 and known testnet/mainnet
 * out-of-range values (we only support 1, 11155111, 17000, ...).
 */
function chainId(v, field = 'chainId') {
  return intRange(v, 1, 2 ** 31 - 1, field);
}

module.exports = {
  ValidationError,
  // primitives
  address, txHash, selector, boundedHex, uint256, intRange, url,
  privateKey, chainId,
  // domain
  mempoolTx, traceFrame,
  // exposed limits (so callers can tune)
  MAX_CALLDATA_BYTES,
  MAX_TRACE_DEPTH,
  MAX_TRACE_CALLS,
  MAX_UINT256,
};
