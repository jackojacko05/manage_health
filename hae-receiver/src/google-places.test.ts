import assert from 'node:assert/strict';
import test from 'node:test';

import { placesFieldMask, PlacesApiError, searchNearbyPlaces } from './google-places';

test('Nearby Search uses a bounded request and parses only candidate fields', async () => {
  let request: RequestInit | undefined;
  const places = await searchNearbyPlaces('test-key', 35.6812, 139.7671, 500, {
    fetchImpl: (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({
        places: [{
          id: 'ChIJtest',
          displayName: { text: 'テスト施設' },
          primaryType: 'cafe',
          formattedAddress: '東京都',
          googleMapsUri: 'https://maps.google.test/place',
          location: { latitude: 35.6813, longitude: 139.7672 },
          reviews: [{ text: 'must not be persisted' }],
        }],
      }), { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(places.length, 1);
  assert.equal(places[0].id, 'ChIJtest');
  assert.equal(places[0].displayName, 'テスト施設');
  assert.equal(places[0].primaryType, 'cafe');
  assert.match(String(request?.headers && new Headers(request.headers).get('X-Goog-FieldMask')), /places\.id/);
  const body = JSON.parse(String(request?.body));
  assert.equal(body.maxResultCount, 5);
  assert.equal(body.locationRestriction.circle.radius, 200);
});

test('Nearby Search retries transient failures and fails without leaking response content', async () => {
  let calls = 0;
  await assert.rejects(
    searchNearbyPlaces('test-key', 35, 139, 100, {
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'secret address' } }), { status: 403 });
      }) as typeof fetch,
      sleep: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PlacesApiError);
      assert.equal(error.code, 'PERMISSION_DENIED');
      assert.doesNotMatch(error.message, /secret address/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('Nearby Search exposes the production field mask as a stable contract', () => {
  assert.equal(
    placesFieldMask,
    'places.id,places.displayName,places.primaryType,places.formattedAddress,places.googleMapsUri,places.location',
  );
});
