import { RelationshipStage } from '@prisma/client';
import {
  checkTransition,
  engagementAdvance,
  nextStage,
  stageRank,
  STAGE_ORDER,
} from './funnel';

/**
 * The funnel rules are the lifecycle Customer-Ops OWNS. These pin the binding
 * transition policy:
 *   - forward exactly one step: allowed (the qualify→convert path)
 *   - backward any number of steps: allowed (demotion / re-qualification)
 *   - forward skipping a step (LEAD→CUSTOMER): REJECTED (no skipping qualification)
 *   - same stage: rejected as a transition
 */
describe('funnel rules', () => {
  it('orders the stages lead < prospect < customer', () => {
    expect(STAGE_ORDER).toEqual([
      RelationshipStage.LEAD,
      RelationshipStage.PROSPECT,
      RelationshipStage.CUSTOMER,
    ]);
    expect(stageRank(RelationshipStage.LEAD)).toBe(0);
    expect(stageRank(RelationshipStage.PROSPECT)).toBe(1);
    expect(stageRank(RelationshipStage.CUSTOMER)).toBe(2);
  });

  describe('forward transitions', () => {
    it('allows LEAD → PROSPECT (one step)', () => {
      const r = checkTransition(RelationshipStage.LEAD, RelationshipStage.PROSPECT);
      expect(r.allowed).toBe(true);
      expect(r.direction).toBe('forward');
    });

    it('allows PROSPECT → CUSTOMER (one step)', () => {
      const r = checkTransition(RelationshipStage.PROSPECT, RelationshipStage.CUSTOMER);
      expect(r.allowed).toBe(true);
      expect(r.direction).toBe('forward');
    });

    it('REJECTS LEAD → CUSTOMER (cannot skip qualification)', () => {
      const r = checkTransition(RelationshipStage.LEAD, RelationshipStage.CUSTOMER);
      expect(r.allowed).toBe(false);
      expect(r.direction).toBe('forward');
      expect(r.reason).toMatch(/cannot skip the funnel/);
      expect(r.reason).toMatch(/PROSPECT/);
    });
  });

  describe('backward transitions', () => {
    it('allows CUSTOMER → PROSPECT (churn/demote one step)', () => {
      const r = checkTransition(RelationshipStage.CUSTOMER, RelationshipStage.PROSPECT);
      expect(r.allowed).toBe(true);
      expect(r.direction).toBe('backward');
    });

    it('allows CUSTOMER → LEAD (demote two steps)', () => {
      const r = checkTransition(RelationshipStage.CUSTOMER, RelationshipStage.LEAD);
      expect(r.allowed).toBe(true);
      expect(r.direction).toBe('backward');
    });

    it('allows PROSPECT → LEAD (cool off)', () => {
      const r = checkTransition(RelationshipStage.PROSPECT, RelationshipStage.LEAD);
      expect(r.allowed).toBe(true);
      expect(r.direction).toBe('backward');
    });
  });

  describe('no-op', () => {
    it('rejects a same-stage transition', () => {
      for (const s of STAGE_ORDER) {
        const r = checkTransition(s, s);
        expect(r.allowed).toBe(false);
        expect(r.direction).toBe('none');
      }
    });
  });

  describe('nextStage', () => {
    it('returns the next stage, null at the end', () => {
      expect(nextStage(RelationshipStage.LEAD)).toBe(RelationshipStage.PROSPECT);
      expect(nextStage(RelationshipStage.PROSPECT)).toBe(RelationshipStage.CUSTOMER);
      expect(nextStage(RelationshipStage.CUSTOMER)).toBeNull();
    });
  });
});

/**
 * The Phase-4 engagement → funnel-stage policy. Pin the binding rules:
 *   - replied/clicked = positive intent → advance exactly one step
 *   - opened = weak → recorded, no advance
 *   - bounced/unsubscribed = data-quality/suppression → never advance
 *   - lost = never advance (re-open first)
 *   - top of funnel (CUSTOMER) = never advance
 */
describe('engagementAdvance (the engagement → stage policy)', () => {
  it('replied advances one step (LEAD→PROSPECT, PROSPECT→CUSTOMER)', () => {
    expect(engagementAdvance(RelationshipStage.LEAD, 'replied', false)).toMatchObject({
      advance: true,
      toStage: RelationshipStage.PROSPECT,
    });
    expect(engagementAdvance(RelationshipStage.PROSPECT, 'replied', false)).toMatchObject({
      advance: true,
      toStage: RelationshipStage.CUSTOMER,
    });
  });

  it('clicked advances one step too (positive intent)', () => {
    expect(engagementAdvance(RelationshipStage.LEAD, 'clicked', false)).toMatchObject({
      advance: true,
      toStage: RelationshipStage.PROSPECT,
    });
  });

  it('never skips qualification: a LEAD reply lands on PROSPECT, not CUSTOMER', () => {
    const d = engagementAdvance(RelationshipStage.LEAD, 'replied', false);
    expect(d.toStage).toBe(RelationshipStage.PROSPECT);
    expect(d.toStage).not.toBe(RelationshipStage.CUSTOMER);
  });

  it('opened is recorded but does NOT advance (weak intent)', () => {
    const d = engagementAdvance(RelationshipStage.LEAD, 'opened', false);
    expect(d.advance).toBe(false);
    expect(d.toStage).toBeNull();
    expect(d.reason).toMatch(/does not advance/i);
  });

  it('bounced / unsubscribed never advance (data-quality / suppression)', () => {
    expect(engagementAdvance(RelationshipStage.LEAD, 'bounced', false).advance).toBe(false);
    expect(engagementAdvance(RelationshipStage.PROSPECT, 'unsubscribed', false).advance).toBe(false);
  });

  it('a lost relationship never advances (re-open first)', () => {
    const d = engagementAdvance(RelationshipStage.PROSPECT, 'replied', true);
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/closed-lost/i);
  });

  it('the top of the funnel never advances (CUSTOMER + reply = no-op)', () => {
    const d = engagementAdvance(RelationshipStage.CUSTOMER, 'replied', false);
    expect(d.advance).toBe(false);
    expect(d.toStage).toBeNull();
    expect(d.reason).toMatch(/top of the funnel/i);
  });
});
