'use strict';

/**
 * KOVER.IA Demo — Terminal UI primitives
 * ---------------------------------------------------------------------------
 * Self-contained ANSI rendering helpers — zero external dependency.
 *
 * Public API:
 *   - C            : palette of escape sequences (`bold`, `red`, ...)
 *   - paint(s, c)  : wraps a string with a colour and resets afterwards
 *   - banner()     : multi-line gradient header for KOVER.IA
 *   - panel(...)   : framed multi-line block with a title + rows
 *   - table(rows)  : two-column key/value table with auto-aligned padding
 *   - progress(...): single-line progress bar with throughput annotation
 *   - rule(width)  : horizontal rule
 *   - section(t)   : section header with arrow + dim subtitle
 *   - clearLine()  : ANSI \x1b[2K + \r
 *   - moveUp(n)    : ANSI \x1b[<n>A
 *
 * Why a homemade UI lib?  Adding `chalk`, `cli-progress` or `boxen` would
 * pull dozens of transitive deps for what amounts to ~25 escape sequences
 * — bad practice in a security-critical service.
 */

// ---------------------------------------------------------------------------
// ANSI palette
// ---------------------------------------------------------------------------

const C = Object.freeze({
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  under:   '\x1b[4m',

  // foreground
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',

  // bright
  brRed:    '\x1b[91m',
  brGreen:  '\x1b[92m',
  brYellow: '\x1b[93m',
  brCyan:   '\x1b[96m',
  brWhite:  '\x1b[97m',

  // background
  bgRed:    '\x1b[41m\x1b[97m',
  bgGreen:  '\x1b[42m\x1b[30m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgBlue:   '\x1b[44m\x1b[97m',
});

/** Wraps `s` with the given style and resets afterwards. */
const paint = (s, ...styles) => `${styles.join('')}${s}${C.reset}`;

// ---------------------------------------------------------------------------
// Width helpers — strip ANSI before measuring
// ---------------------------------------------------------------------------

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Visible character count of a string after stripping ANSI escapes. */
function visibleLength(s) {
  return String(s).replace(ANSI_REGEX, '').length;
}

/** Right-pad a (possibly coloured) string to `n` visible columns. */
function padRight(s, n, fill = ' ') {
  const v = visibleLength(s);
  return v >= n ? s : s + fill.repeat(n - v);
}

/** Centre a string inside a `n`-wide field. */
function centre(s, n, fill = ' ') {
  const v = visibleLength(s);
  if (v >= n) return s;
  const left = Math.floor((n - v) / 2);
  const right = n - v - left;
  return fill.repeat(left) + s + fill.repeat(right);
}

// ---------------------------------------------------------------------------
// Cursor + line control
// ---------------------------------------------------------------------------

const clearLine = () => process.stdout.write('\x1b[2K\r');
const moveUp = (n = 1) => process.stdout.write(`\x1b[${n}A`);
const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 78;

function rule(width = DEFAULT_WIDTH, char = '─', colour = C.dim) {
  console.log(paint(char.repeat(width), colour));
}

function blank() {
  console.log('');
}

function section(title, subtitle = '') {
  console.log(`\n${paint('▶', C.yellow)} ${paint(title, C.bold)}${subtitle ? '  ' + paint(`// ${subtitle}`, C.dim) : ''}`);
}

function banner() {
  const lines = [
    `${C.cyan}${C.bold}  ╦╔═ ╔═╗ ╦  ╦ ╔═╗ ╦═╗   ╦ ╔═╗   ${C.reset}${C.dim}// behavioral flow detection${C.reset}`,
    `${C.cyan}${C.bold}  ╠╩╗ ║ ║ ╚╗╔╝ ║╣  ╠╦╝   ║ ╠═╣   ${C.reset}${C.dim}// flashloan interception engine${C.reset}`,
    `${C.cyan}${C.bold}  ╩ ╩ ╚═╝  ╚╝  ╚═╝ ╩╚═ ╩ ╩ ╩ ╩   ${C.reset}${C.dim}// production demo — mainnet-grade${C.reset}`,
  ];
  console.log('\n' + lines.join('\n') + '\n');
  rule();
}

/**
 * Renders a key/value panel with a title bar.
 *
 * @param {string} title
 * @param {Array<[string, string] | { k: string, v: string }>} rows
 * @param {{width?: number, keyWidth?: number}} [opts]
 */
function panel(title, rows, opts = {}) {
  const width = opts.width || DEFAULT_WIDTH;
  const keyWidth = opts.keyWidth || 22;
  const top    = '┌' + '─'.repeat(width - 2) + '┐';
  const mid    = '├' + '─'.repeat(width - 2) + '┤';
  const bot    = '└' + '─'.repeat(width - 2) + '┘';

  console.log(paint(top, C.dim));
  console.log(paint('│', C.dim) + ' ' + paint(title, C.bold) + ' '.repeat(Math.max(0, width - 3 - visibleLength(title))) + paint('│', C.dim));
  console.log(paint(mid, C.dim));
  for (const row of rows) {
    const [k, v] = Array.isArray(row) ? row : [row.k, row.v];
    const left  = ' ' + padRight(paint(k, C.dim), keyWidth);
    // Inside-frame width is (width - 2). left + right must equal that.
    const rightSpace = Math.max(0, width - 2 - visibleLength(left));
    let value = String(v ?? '');
    // Best-effort truncation if the value overflows — append a reset to make
    // sure no dangling colour bleeds onto the border.
    if (visibleLength(value) > rightSpace) {
      value = value.slice(0, rightSpace) + C.reset;
    }
    const right = padRight(value, rightSpace);
    console.log(paint('│', C.dim) + left + right + paint('│', C.dim));
  }
  console.log(paint(bot, C.dim));
}

/**
 * Two-column key/value table without a frame — used for compact inline lists.
 */
function table(rows, { keyWidth = 22, indent = '  ' } = {}) {
  for (const row of rows) {
    const [k, v] = Array.isArray(row) ? row : [row.k, row.v];
    console.log(`${indent}${padRight(paint(k, C.dim), keyWidth)}${v}`);
  }
}

/**
 * Single-line progress bar.
 *
 * @param {number} done
 * @param {number} total
 * @param {string} suffix  text printed to the right of the bar
 * @param {{ width?: number, fill?: string, empty?: string }} [opts]
 */
function progress(done, total, suffix, opts = {}) {
  const width = opts.width ?? 36;
  const fill = opts.fill ?? '▣';
  const empty = opts.empty ?? '░';
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  const filled = Math.round(ratio * width);
  const bar = paint(fill.repeat(filled), C.cyan) + paint(empty.repeat(width - filled), C.dim);
  const pct = (ratio * 100).toFixed(1).padStart(5, ' ');
  return `   ${bar}  ${paint(pct + '%', C.bold)}   ${suffix}`;
}

/** Big highlighted verdict block (used twice — neutralised, postmortem). */
function verdict(message, style = C.bgGreen) {
  const w = DEFAULT_WIDTH;
  rule(w);
  console.log(paint(' '.repeat(w), style));
  console.log(paint(centre(message, w), style + C.bold));
  console.log(paint(' '.repeat(w), style));
  rule(w);
}

module.exports = {
  C, paint,
  visibleLength, padRight, centre,
  clearLine, moveUp, hideCursor, showCursor,
  rule, blank, section,
  banner, panel, table, progress, verdict,
};
