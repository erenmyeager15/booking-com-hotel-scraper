export interface ActorInput {
  destinations?: string[];
  searchUrls?: string[];
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  rooms?: number;
  childrenAges?: number[];
  propertyTypes?: string[];
  stars?: number[];
  minReviewScore?: number;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: SortBy;
  maxResults?: number;
  currency?: string;
  language?: string;
  scrapeDetails?: boolean;
  maxImages?: number;
  proxyConfiguration?: ProxyConfigInput;
  allowResidentialFallback?: boolean;
  maxPagesPerSearch?: number;
  trackChanges?: boolean;
  monitorName?: string;
  priceChangeThresholdPercent?: number;
  observationHistoryLimit?: number;
}

export type SortBy = 'popularity' | 'priceLowToHigh' | 'reviewScore' | 'distance';

export interface ProxyConfigInput {
  useApifyProxy?: boolean;
  apifyProxyGroups?: string[];
  apifyProxyCountry?: string;
  proxyUrls?: string[];
}

export interface NormalizedInput {
  destinations: string[];
  searchUrls: string[];
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  childrenAges: number[];
  propertyTypes: string[];
  stars: number[];
  minReviewScore: number;
  minPrice: number | null;
  maxPrice: number | null;
  sortBy: SortBy;
  maxResults: number;
  currency: string;
  language: string;
  scrapeDetails: boolean;
  maxImages: number;
  proxyConfiguration: ProxyConfigInput;
  allowResidentialFallback: boolean;
  maxPagesPerSearch: number;
  trackChanges: boolean;
  monitorName: string;
  priceChangeThresholdPercent: number;
  observationHistoryLimit: number;
}

export interface RoomOption {
  roomName: string | null;
  bedType: string | null;
  occupancy: number | null;
  totalPrice: number | null;
  currency: string | null;
  mealPlan: string | null;
  cancellationPolicy: string | null;
  freeCancellation: boolean;
  refundable: boolean | null;
  available: boolean;
  unitsLeft: number | null;
  amenities: string[];
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
  available: boolean | null;
  availabilityStatus: 'available' | 'sold_out' | 'unknown';
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  rooms: number;
  scrapeMode: 'fast' | 'detailed';
  billingTier: 'fast' | 'detailed-datacenter';
  sourceUrl: string;
  address: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  facilities: string[];
  imageUrls: string[];
  roomOptions: RoomOption[];
  surroundings: string[];
  destination: string;
  scrapedAt: string;
  childrenAges?: number[];
  rateEvidence?: RateEvidence;
  rateChange?: RateChange;
}

export interface RateEvidence {
  priceBasis: 'displayed_stay_total' | 'displayed_nightly_rate' | 'unpriced';
  requestedCurrency: string;
  observedCurrency: string | null;
  currencyStatus: 'confirmed' | 'ambiguous' | 'mismatch' | 'unknown';
  taxStatus: 'included' | 'excluded' | 'mixed' | 'unknown';
  taxText: string | null;
  observedTotalText: string | null;
  observedNightlyText: string | null;
  searchContextVerified: boolean;
  comparisonWarnings: string[];
  comparisonScope: 'hotel_search_offer';
}

export interface RateObservation {
  at: string;
  totalPrice: number | null;
  pricePerNight: number | null;
  availabilityStatus: HotelRecord['availabilityStatus'];
}
export interface RateChange {
  monitorName: string;
  status: 'baseline' | 'unchanged' | 'price_drop' | 'price_increase' | 'not_comparable';
  reason: string | null;
  previousObservedAt: string | null;
  previousTotalPrice: number | null;
  totalPriceChange: number | null;
  priceChangePercent: number | null;
  alert: boolean;
  observations: RateObservation[];
}

export interface SearchState {
  destination: string;
  /** Distinguishes proxy tiers and duplicate destination searches in Crawlee's shared request queue. */
  requestNamespace?: string;
  searchUrl?: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  childrenAges?: number[];
  propertyTypes: string[];
  stars?: number[];
  minReviewScore: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  sortBy?: SortBy;
  maxResults: number;
  currency: string;
  language?: string;
  scrapeDetails?: boolean;
  maxImages?: number;
  collectedCount: number;
  examinedCount: number;
  seenIds: string[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
  maxPages?: number;
  coverage?: { status: 'pending' | 'complete' | 'empty' | 'limited' | 'failed'; successfulPages: number; reason: string | null };
}

export interface DetailRequestData {
  state: SearchState;
  record: HotelRecord;
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
