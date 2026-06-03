import { RelationshipStage } from '@prisma/client';
import { checkTransition, nextStage, stageRank, STAGE_ORDER } from './funnel';

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
