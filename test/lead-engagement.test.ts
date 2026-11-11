import test from 'node:test';
import assert from 'node:assert/strict';
import { isEngagementEligible, requiredReviewedForDeliveryCount } from '../src/lead-engagement.js';

test('the policy uses exact ceil arithmetic and starts gating only at scan three', () => {
  assert.equal(requiredReviewedForDeliveryCount(20), 16);
  assert.equal(requiredReviewedForDeliveryCount(30), 24);
  assert.equal(requiredReviewedForDeliveryCount(1), 1);
  assert.equal(requiredReviewedForDeliveryCount(0), 0);
  assert.equal(isEngagementEligible(1, 20, 0), true);
  assert.equal(isEngagementEligible(2, 20, 0), true);
  assert.equal(isEngagementEligible(3, 20, 15), false);
  assert.equal(isEngagementEligible(3, 20, 16), true);
  assert.equal(isEngagementEligible(3, 30, 23), false);
  assert.equal(isEngagementEligible(3, 30, 24), true);
  assert.equal(isEngagementEligible(3, 0, 0), true);
});
