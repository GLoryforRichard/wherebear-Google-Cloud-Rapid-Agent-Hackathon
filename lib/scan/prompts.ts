/**
 * Prompts + strict JSON schemas for the shelf-scan engine. Ported verbatim
 * from whataisle-readshelf (benchmarked wording — do not tweak casually;
 * detection quality was measured against these exact prompts).
 */

/** Rows mode: the model sees one horizontal strip cut from the shelf photo. */
export const BAND_PROMPT = `You are analyzing a horizontal strip cut from a larger photo of a retail store shelf. Your task is exhaustive product-type detection within this strip.

Identify every distinct product TYPE visible. Identical products are stacked or lined up next
to each other in groups; draw exactly ONE bounding box per group that tightly encloses ALL
adjacent copies of that identical product. Do not draw one box per individual item.
Different sizes or flavors of the same brand are DIFFERENT product types.
Include products that are partially cut off at the top or bottom edge of the strip.
Do not miss any product type. Do not box shelf-edge price labels, only products.

Return ONLY JSON matching this exact format, with no other text:
{"boxes": [{"label": "<short product description>", "box_2d": [ymin, xmin, ymax, xmax]}, ...]}

box_2d coordinates are integers normalized to a 0-1000 scale relative to THIS strip image
(0,0 = top-left corner, 1000,1000 = bottom-right corner).`;

export const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['boxes'],
  properties: {
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'box_2d'],
        properties: {
          label: { type: 'string' },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
          },
        },
      },
    },
  },
} as const;

export const ROW_DETECT_PROMPT = `This is a photo of retail store shelving. Identify the horizontal shelf rows — the bands of products between shelf boards, from top to bottom.

Return ONLY JSON: {"rows": [{"y0": <int>, "y1": <int>}, ...]}
where y0/y1 are the top and bottom of each product row on a 0-1000 scale (0 = image top),
in top-to-bottom order, covering every region that contains products.`;

export const ROWS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['y0', 'y1'],
        properties: { y0: { type: 'integer' }, y1: { type: 'integer' } },
      },
    },
  },
} as const;

/** Per-box crop name reading (fixes copy-paste mislabels from detection). */
export const READ_NAME_PROMPT = `This is a close-up crop of one product (or a stack of identical products) from a retail shelf photo. Identify the product from what is actually visible/readable in this crop: brand and product name, plus the variant if clearly readable (e.g. flavor, type, "2% partly skimmed", "sans gras"). Do not guess sizes or volumes. If the label text is unreadable, describe the product generically (e.g. "red canned drink").

Return ONLY JSON: {"name": "<short product name>"}`;

export const READ_NAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } },
} as const;

/** Grid readout: K numbered crops stitched into one image, one call reads all. */
export function buildGridReadPrompt(k: number): string {
  return `The image is a grid of ${k} numbered cells (the number is drawn at the top-left corner above each cell). Each cell is a close-up crop of one product (or a stack of identical products) from a retail shelf photo. The cells are UNRELATED to each other — identify each one independently.

STRICT rules:
- Each answer describes exactly ONE product: the one inside that numbered cell's gray border.
- NEVER mention a product from a neighboring cell; NEVER join two products with "and".
- If a cell seems to show parts of two different products, name only the one occupying most of the cell.

For each numbered cell, identify the product from what is actually visible/readable in that cell: brand and product name, plus the variant if clearly readable (e.g. flavor, type, "2% partly skimmed", "sans gras"). Do not guess sizes or volumes. If a cell's label text is unreadable, describe that product generically (e.g. "red canned drink").

Return ONLY JSON: {"names": ["<name for cell 1>", "<name for cell 2>", ...]} with exactly ${k} strings in cell-number order.`;
}

export function buildGridReadSchema(k: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['names'],
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        minItems: k,
        maxItems: k,
      },
    },
  };
}

/**
 * Landing try-out gate: one cheap call screens the upload before the
 * expensive detection run. Both booleans must be true to proceed.
 */
export const PRECHECK_PROMPT = `You are screening an uploaded photo for a retail shelf-scanning demo. Answer two booleans.

is_shelf: true only if the photo mainly shows retail shelving or a store display stocked with products for sale — not a single held product, not a home fridge or pantry, not an unrelated scene.

labels_legible: true only if product packaging text in the photo is sharp enough that most product names could be read by zooming in — false if the photo is blurry, taken from too far away, or too dark.

Return ONLY JSON matching the schema.`;

export const PRECHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_shelf', 'labels_legible'],
  properties: {
    is_shelf: { type: 'boolean' },
    labels_legible: { type: 'boolean' },
  },
} as const;
