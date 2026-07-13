export interface ActorInput {
  destinations?: string[];
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  rooms?: number;
  propertyTypes?: string[];
  minReviewScore?: number;
  maxResults?: number;
  currency?: string;
  proxyConfiguration?: ProxyConfigInput;
}

export interface ProxyConfigInput {
  useApifyProxy?: boolean;
  apifyProxyGroups?: string[];
  apifyProxyCountry?: string;
  proxyUrls?: string[];
}

export interface NormalizedInput {
  destinations: string[];
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  propertyTypes: string[];
  minReviewScore: number;
  maxResults: number;
  currency: string;
  proxyConfiguration: ProxyConfigInput;
}

export interface HotelRecord {
  propertyId: string;
  hotelName: string | null;
  starRating: number | null;
  guestReviewScore: number | null;
  reviewCount: number | null;
  city: string | null;
  country: string | null;
  distanceFromCityCenter: string | null;
  totalPrice: number | null;
  pricePerNight: number | null;
  originalPrice: number | null;
  discountPercentage: number | null;
  currency: string | null;
  freeCancellation: boolean;
  propertyUrl: string | null;
  thumbnailImageUrl: string | null;
  sustainabilityBadge: boolean;
  geniusDiscount: boolean;
  destination: string;
  scrapedAt: string;
}

export interface SearchState {
  destination: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  propertyTypes: string[];
  minReviewScore: number;
  maxResults: number;
  currency: string;
  collectedCount: number;
  examinedCount: number;
  seenIds: string[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
}

export const PROPERTY_TYPE_HT_IDS: Record<string, string> = {
  Hotels: 'ht_id=201',
  Apartments: 'ht_id=203',
  Hostels: 'ht_id=205',
  Villas: 'ht_id=204',
  Resorts: 'ht_id=202',
  'B&Bs': 'ht_id=206',
  'Guest houses': 'ht_id=207',
};
