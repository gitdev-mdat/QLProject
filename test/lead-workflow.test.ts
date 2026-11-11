import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_STATUS_VALUES, statusLabel } from '../web/lib/lead-workflow.js';

test('not_interested is distinct from not_fit and has the Vietnamese customer label', () => {
  assert.ok(LEAD_STATUS_VALUES.includes('not_interested'));
  assert.notEqual('not_fit', 'not_interested');
  assert.equal(statusLabel.not_interested, 'Không quan tâm');
  assert.equal(statusLabel.not_fit, 'Không phù hợp');
});
