import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_QUERY_LENGTH,
  contactOptionLabel,
  createPayloadFor,
  searchContactOptions,
} from './contactPicker.ts';

const jane = { contactId: 'p-1', displayName: 'Jane Lead', primaryEmail: 'jane@example.com' };

describe('contact picker', () => {
  it('shows name + email for each option, name alone when there is no email', () => {
    assert.deepEqual(contactOptionLabel(jane), { title: 'Jane Lead', subtitle: 'jane@example.com' });
    assert.deepEqual(contactOptionLabel({ ...jane, primaryEmail: null }), { title: 'Jane Lead', subtitle: '' });
  });

  it('searches through the injected fetcher only for a long-enough query', async () => {
    const calls = [];
    const fetcher = async (ws, q) => {
      calls.push([ws, q]);
      return [jane];
    };
    assert.equal(MIN_QUERY_LENGTH, 2);
    assert.deepEqual(await searchContactOptions('ws-1', ' j ', fetcher), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(await searchContactOptions('ws-1', ' jan ', fetcher), [jane]);
    assert.deepEqual(calls, [['ws-1', 'jan']]);
  });

  it('submits the picked contact id, and nothing for free text', () => {
    assert.deepEqual(createPayloadFor(jane), { contactId: 'p-1' });
    assert.equal(createPayloadFor(null), null);
  });
});
