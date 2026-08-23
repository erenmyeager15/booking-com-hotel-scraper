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
}

export interface SearchState {
  destination: string;
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
