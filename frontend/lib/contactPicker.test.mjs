import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_QUERY_LENGTH,
  NOT_CONNECTED_MESSAGE,
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
      return { items: [jane], notConnected: false };
    };
    assert.equal(MIN_QUERY_LENGTH, 2);
    assert.deepEqual(await searchContactOptions('ws-1', ' j ', fetcher), { items: [], notConnected: false });
    assert.equal(calls.length, 0);
    assert.deepEqual(await searchContactOptions('ws-1', ' jan ', fetcher), { items: [jane], notConnected: false });
    assert.deepEqual(calls, [['ws-1', 'jan']]);
  });

  it('submits the picked contact id, and nothing for free text', () => {
    assert.deepEqual(createPayloadFor(jane), { contactId: 'p-1' });
    assert.equal(createPayloadFor(null), null);
  });

  it('passes the notConnected flag through and names the sentence to show', async () => {
    const fetcher = async () => ({ items: [], notConnected: true });
    assert.deepEqual(await searchContactOptions('ws-1', 'jan', fetcher), { items: [], notConnected: true });
    assert.equal(NOT_CONNECTED_MESSAGE, "Contacts aren't set up for this workspace yet, so a relationship can't be linked to a contact. Ask your workspace owner, or write to support@unicorncommander.ai and we will set it up.");
  });
});
