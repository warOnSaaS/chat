import crypto from 'node:crypto';

// Ids that sort by time, so "newer than the last one I read" is a plain comparison on any database.
// 9 characters of milliseconds, 3 of a per-process counter, 5 random: m_0mfx3k2a1000a1b2c
let lastMs = 0, seq = 0;
export function newId(prefix) {
  const ms = Date.now();
  if (ms === lastMs) seq++; else { lastMs = ms; seq = 0; }
  return `${prefix}_${ms.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
}
export const nowIso = () => new Date().toISOString();

// An id for a moment in the past (example data): same layout, so it sorts among real ones.
let pastSeq = 0;
export function idAt(prefix, ms) {
  pastSeq = (pastSeq + 1) % 46656;
  return `${prefix}_${Math.floor(ms).toString(36).padStart(9, '0')}${pastSeq.toString(36).padStart(3, '0')}${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
}
