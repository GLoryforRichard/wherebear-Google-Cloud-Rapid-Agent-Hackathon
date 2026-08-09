import { ObjectId } from 'mongodb';

export interface ShelfEvidence {
  _id?: ObjectId;
  photo_url: string;
  aisle: string;
  products_detected: string[];
  raw_ocr_text?: string;
  timestamp: Date;
}

export interface Product {
  _id?: ObjectId;
  canonical_name: string;
  /** Normalized identity key (see lib/name-key.ts) — unique; the upsert
   *  filter, so case/punctuation re-readings of the same SKU merge into one
   *  doc instead of forking. */
  name_key: string;
  aliases: string[];
  search_text: string;
  category?: string;
  latest_aisle: string;
  /** Every distinct shelf this SKU was seen on. */
  aisles?: string[];
  /** Last sighting per aisle, e.g. { B4: Date, B11: Date } — compared against
   *  shelf_evidence re-scan times to grey out locations the item likely left. */
  aisle_seen?: Record<string, Date>;
  evidence_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface SearchLog {
  _id?: ObjectId;
  query: string;
  resolved_intent?: string;
  results_found: number;
  no_result_terms?: string[];
  timestamp: Date;
}
