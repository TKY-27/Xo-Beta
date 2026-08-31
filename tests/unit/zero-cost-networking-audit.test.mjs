import { describe, expect, it } from 'vitest';
import { scanText } from '../../scripts/audit-zero-cost-networking.mjs';

describe('zero-cost networking audit rules', () => {
  it('rejects canonical TURN and TURN-over-TLS URI forms', () => {
    expect(scanText('const relay = "turn:relay.example:3478";', 'fixture.js'))
      .toEqual([{ file: 'fixture.js', rule: 'turn-uri', line: 1 }]);
    expect(scanText('const relay = "turns:relay.example:5349";', 'fixture.js'))
      .toEqual([{ file: 'fixture.js', rule: 'turn-uri', line: 1 }]);
  });

  it('accepts STUN-only text and ignores the dependency API marker in dist', () => {
    expect(scanText('const server = "stun:stun.example:3478";', 'fixture.js')).toEqual([]);
    expect(scanText('function create(options) { return options.turnConfig; }', 'dist/assets/vendor.js'))
      .toEqual([]);
  });
});
