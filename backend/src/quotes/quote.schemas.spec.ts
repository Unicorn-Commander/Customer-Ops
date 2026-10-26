import * as S from './quote.schemas';

// Zod 4 applies .default() inside optional fields; partial updates must not inherit create defaults.
describe('quote update schemas', () => {
  it('a partial line update carries only the fields it names', () => {
    expect(S.lineUpdate.parse({ discountBps: 1000 })).toEqual({ discountBps: 1000 });
    expect(S.lineUpdate.parse({ qty: '2.5' })).toEqual({ qty: '2.5' });
    expect(S.lineUpdate.parse({})).toEqual({});
  });

  it('a partial quote update carries only the fields it names', () => {
    expect(S.quoteUpdate.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
    expect(S.quoteUpdate.parse({ showDeliveryPartner: false })).toEqual({
      showDeliveryPartner: false,
    });
  });

  it('update schemas stay strict and keep the field validation', () => {
    expect(() => S.lineUpdate.parse({ bogus: 1 })).toThrow();
    expect(() =>
      S.quoteUpdate.parse({ customerId: '00000000-0000-4000-8000-000000000000' }),
    ).toThrow();
    expect(() => S.lineUpdate.parse({ qty: '-1' })).toThrow();
    expect(() => S.quoteUpdate.parse({ currency: 'US' })).toThrow();
  });

  it('create schemas still apply their defaults', () => {
    expect(
      S.lineInput.parse({ kind: 'one_time', label: 'Line', unitPriceCents: 100 }),
    ).toMatchObject({
      position: 0,
      descriptionMd: '',
      qty: 1,
      unit: 'item',
      statusTag: 'proposed',
      selected: false,
    });
    expect(
      S.quoteCreate.parse({
        customerId: '00000000-0000-4000-8000-000000000000',
        title: 'Quote',
        vendorOfRecord: 'Vendor',
      }),
    ).toMatchObject({ currency: 'USD', showDeliveryPartner: true });
  });
});
