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
  aliases: string[];
  search_text: string;
  category?: string;
  latest_aisle: string;
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
