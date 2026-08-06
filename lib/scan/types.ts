/**
 * Shared types for the shelf-scan engine (ported from whataisle-readshelf,
 * the model-comparison harness whose champion pipeline this is).
 */

export interface NormalizedBox {
  label: string;
  /** Fractions (0-1) of the source image; x,y = top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParseInfo {
  ok: boolean;
  coordOrderUsed: 'yx' | 'xy' | null;
  scaleDetected: '0-1' | '0-1000' | 'pixels' | null;
  warnings: string[];
}

export interface Band {
  /**
   * core = this band's owned region (cores tile [0,1] with no gaps);
   * y0/y1 = expanded slice actually sent to the model (core ± overlap).
   */
  core0: number;
  core1: number;
  y0: number;
  y1: number;
}

/** An upright JPEG buffer plus its pixel dimensions. */
export interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}
