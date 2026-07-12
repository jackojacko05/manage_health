export interface NearbyPlaceCandidate {
  id: string;
  displayName: string | null;
  primaryType: string | null;
  formattedAddress: string | null;
  googleMapsUri: string | null;
  latitude: number | null;
  longitude: number | null;
}

export class PlacesApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Places API request failed: ${code}`);
    this.name = 'PlacesApiError';
    this.status = status;
    this.code = code;
  }
}

type FetchLike = typeof fetch;

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.primaryType',
  'places.formattedAddress',
  'places.googleMapsUri',
  'places.location',
].join(',');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePlace(value: unknown): NearbyPlaceCandidate | null {
  const place = asRecord(value);
  if (!place) return null;
  const id = nonEmptyString(place.id);
  if (!id) return null;

  const displayName = asRecord(place.displayName);
  const location = asRecord(place.location);
  return {
    id,
    displayName: nonEmptyString(displayName?.text),
    primaryType: nonEmptyString(place.primaryType),
    formattedAddress: nonEmptyString(place.formattedAddress),
    googleMapsUri: nonEmptyString(place.googleMapsUri),
    latitude: finiteNumber(location?.latitude),
    longitude: finiteNumber(location?.longitude),
  };
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function apiErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  return nonEmptyString(error?.status)
    || nonEmptyString(error?.message)?.slice(0, 80).replace(/[^A-Za-z0-9_.-]/g, '_')
    || `HTTP_${status}`;
}

function boundedRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return 100;
  return Math.max(50, Math.min(200, Math.round(radiusM)));
}

export async function searchNearbyPlaces(
  apiKey: string,
  latitude: number,
  longitude: number,
  radiusM: number,
  options: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<NearbyPlaceCandidate[]> {
  if (!apiKey.trim()) throw new PlacesApiError(401, 'missing_api_key');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new PlacesApiError(400, 'invalid_latitude');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new PlacesApiError(400, 'invalid_longitude');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = {
    maxResultCount: 5,
    rankPreference: 'DISTANCE',
    locationRestriction: {
      circle: {
        center: { latitude, longitude },
        radius: boundedRadius(radiusM),
      },
    },
    languageCode: 'ja',
    regionCode: 'JP',
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt === 2) throw new PlacesApiError(503, 'NETWORK_ERROR');
      await sleep(250 * (2 ** attempt));
      continue;
    }

    const raw = await response.text();
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (response.ok) {
      const root = asRecord(payload);
      const places = Array.isArray(root?.places) ? root.places : [];
      return places.map(parsePlace).filter((place): place is NearbyPlaceCandidate => place !== null);
    }

    const code = apiErrorCode(payload, response.status);
    if (!retryableStatus(response.status) || attempt === 2) {
      throw new PlacesApiError(response.status, code);
    }
    await sleep(250 * (2 ** attempt));
  }

  throw new PlacesApiError(503, 'RETRY_EXHAUSTED');
}

export async function refreshPlaceId(
  apiKey: string,
  placeId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  const cleanId = placeId.trim();
  if (!cleanId) throw new PlacesApiError(400, 'missing_place_id');
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(cleanId)}?fields=id`,
    {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id',
      },
    },
  );
  if (response.ok) return true;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Keep the error generic; the response body may contain Google content.
  }
  throw new PlacesApiError(response.status, apiErrorCode(payload, response.status));
}

export const placesFieldMask = FIELD_MASK;
