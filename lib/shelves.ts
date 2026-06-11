/**
 * Wherebear store map.
 *
 * Each shelf has a short code shown in the UI (A1..B11) and a list of
 * category keywords that prime Gemini Vision (so it knows what to look
 * for) and Agent A (so it knows what category to save).
 *
 * The categories are exhaustive enough that a worker tapping "B6" tells
 * the agent "this shelf is instant noodles" without typing anything.
 */

export interface ShelfLocation {
  /** Short code shown in compact UI ("B6") */
  code: string;
  /** Human-readable description shown in dropdown options */
  description: string;
  /** Keywords (EN + zh) used to prime Vision + Agent prompts */
  categories: string[];
}

const MAIN_SHELVES: ShelfLocation[] = [
  // ─── A 区 ───
  { code: 'A1', description: 'Cereal / Oats / Jam / Peanut Butter / Honey',
    categories: ['cereal', 'oats', 'jam', 'peanut butter', 'honey', 'breakfast spread',
                 '早餐麦片', '燕麦', '果酱', '花生酱', '蜂蜜'] },
  { code: 'A2', description: 'Tea / Tapioca / Instant Drink / Coffee',
    categories: ['tea', 'tapioca', 'instant drink', 'coffee', 'powdered beverage',
                 '茶', '西米', '速溶饮料', '咖啡'] },
  { code: 'A3', description: 'Philippine Crackers & Snacks / Shredded Dried Meat / Jerky',
    categories: ['philippine crackers', 'philippine snacks', 'shredded pork', 'pork floss',
                 'beef jerky', 'pork jerky',
                 '菲律宾饼干', '菲律宾零食', '肉松', '猪肉干', '牛肉干'] },
  { code: 'A4', description: 'Popcorn / Cookies / Egg Roll / Biscuits',
    categories: ['popcorn', 'cookies', 'egg roll', 'biscuits', 'wafer',
                 '爆米花', '曲奇', '蛋卷', '饼干'] },
  { code: 'A5', description: 'Roasted Seaweed / Korean / Chinese / Japanese / Indian Snacks',
    categories: ['roasted seaweed', 'korean snacks', 'chinese snacks', 'japanese snacks',
                 'indian snacks', 'pocky', 'pejoy', 'wasabi peas',
                 '零食海苔', '韩式零食', '中式零食', '日式零食', '印度零食'] },
  { code: 'A6', description: 'Jelly / Candy',
    categories: ['jelly', 'jelly cup', 'gummy', 'candy', 'hard candy', 'lollipop',
                 'mints', 'chocolate',
                 '果冻', '糖果', '软糖', '硬糖'] },
  { code: 'A7', description: 'Cooking Oil / Vinegar / Salt',
    categories: ['cooking oil', 'vegetable oil', 'olive oil', 'sesame oil', 'vinegar',
                 'rice vinegar', 'black vinegar', 'salt',
                 '食用油', '醋', '盐', '香醋'] },
  { code: 'A8', description: 'Household Supplies',
    categories: ['household supplies', 'cleaning', 'detergent', 'soap', 'paper towel',
                 'toilet paper', 'tissue',
                 '日用品', '洗涤剂', '纸巾'] },
  { code: 'A9', description: 'Household Hardware / Kitchenware',
    categories: ['household hardware', 'kitchenware', 'pot', 'pan', 'utensil',
                 'chopstick', 'container', 'plastic wrap',
                 '日用五金', '厨具', '锅', '筷子', '保鲜膜'] },
  { code: 'A10', description: 'Household Hardware / Kitchenware (2)',
    categories: ['household hardware', 'kitchenware', 'pot', 'pan', 'utensil',
                 'chopstick', 'container', 'plastic wrap',
                 '日用五金', '厨具', '锅', '筷子', '保鲜膜'] },
  { code: 'A11', description: 'Rice',
    categories: ['rice', 'jasmine rice', 'basmati rice', 'sushi rice', 'sticky rice',
                 'glutinous rice', 'brown rice',
                 '米', '大米', '香米', '糯米', '糙米', '寿司米'] },
  { code: 'A12', description: 'Aisle A end shelf',
    categories: [] },

  // ─── B 区 ───
  { code: 'B1', description: 'Nuts / Dates / Dried Fruits',
    categories: ['nuts', 'almond', 'cashew', 'walnut', 'pistachio', 'dates', 'dried fruit',
                 'raisin', 'dried apricot', 'dried mango',
                 '坚果', '蜜枣', '果干', '杏仁', '腰果', '核桃'] },
  { code: 'B2', description: 'Pasta / Mayo / Canned Tomato / Ketchup / Olives / Pickle / Soup',
    categories: ['pasta', 'spaghetti', 'macaroni', 'mayonnaise', 'canned tomato',
                 'ketchup', 'olive', 'pickle', 'soup', 'soup mix',
                 '意大利面', '美乃滋', '罐头番茄', '番茄酱', '橄榄', '腌制蔬菜', '汤包'] },
  { code: 'B3', description: 'Vietnamese / Philippine Sauce / Fish Sauce / Philippine Noodles',
    categories: ['vietnamese sauce', 'philippine sauce', 'fish sauce', 'philippine noodles',
                 'pancit', 'nuoc mam', 'hoisin',
                 '越南酱料', '菲律宾酱料', '鱼露', '菲律宾面类'] },
  { code: 'B4', description: 'Soy Sauce / Japanese & Korean Sauce / Oyster / Cooking Wine / Sushi Nori / Sesame',
    categories: ['soy sauce', 'japanese sauce', 'oyster sauce', 'korean sauce', 'gochujang',
                 'doenjang', 'cooking wine', 'mirin', 'sake', 'sushi nori', 'seaweed sheet',
                 'preserved bean curd', 'fermented tofu', 'sesame', 'sesame oil',
                 '酱油', '日式酱料', '韩式酱料', '耗油', '蚝油', '料酒', '寿司紫菜', '海苔',
                 '腐乳', '芝麻', '麻油'] },
  { code: 'B5', description: 'Hotpot Base / Dry Noodles / Chinese Pickle / Rice Sticks / Mushroom / Rice Paper / Chinese Spice',
    categories: ['hotpot soup base', 'hot pot base', 'dry noodles', 'wheat noodles',
                 'chinese pickle', 'rice sticks', 'rice noodles', 'dried mushroom',
                 'shiitake', 'wood ear', 'rice paper', 'spring roll wrapper',
                 'chinese spices', 'five spice', 'star anise', 'sichuan peppercorn',
                 '火锅底料', '面', '酱菜', '河粉', '香菇', '木耳', '米纸', '中式调味',
                 '五香', '八角', '花椒'] },
  { code: 'B6', description: 'Instant Noodles',
    categories: ['instant noodles', 'instant ramen', 'cup noodle', 'shin ramyun',
                 'samyang', 'nissin', 'indomie', 'maggi', 'mama',
                 '方便面', '泡面', '杯面', '辛拉面', '出前一丁'] },
  { code: 'B7', description: 'Condensed Milk / Coconut Milk & Oil / Canned Fruits / Canned Corn & Mushroom',
    categories: ['condensed milk', 'coconut milk', 'coconut oil', 'canned fruit',
                 'canned pineapple', 'canned peach', 'lychee', 'canned corn',
                 'canned mushroom',
                 '炼奶', '椰奶', '椰油', '水果罐头', '罐头玉米', '罐头菇'] },
  { code: 'B8', description: 'African Foods / Latino Foods / Spices / Caribbean Sauce',
    categories: ['african foods', 'latino foods', 'spices', 'seasoning', 'caribbean sauce',
                 'jerk sauce', 'plantain chips', 'tortilla',
                 '非洲食品', '南美食品', '调味品', '加勒比酱料'] },
  { code: 'B9', description: 'Indian Sauce / Indian Spice / Middle Eastern Foods',
    categories: ['indian sauce', 'curry sauce', 'masala', 'indian spice', 'turmeric',
                 'garam masala', 'middle eastern foods', 'tahini', 'za\'atar',
                 'gits', 'mdh', 'national',
                 '印度酱料', '咖喱', '印度调味品', '中东食品'] },
  { code: 'B10', description: 'Canned & Dried Beans / Canned Fish / Raw Peanut / Canned Meat',
    categories: ['canned bean', 'dried bean', 'lentil', 'chickpea', 'kidney bean',
                 'mung bean', 'red bean', 'canned fish', 'sardine', 'tuna', 'mackerel',
                 'raw peanut', 'canned meat', 'spam', 'corned beef',
                 '豆类罐头', '包装豆类', '鱼类罐头', '花生', '肉类罐头', '午餐肉'] },
  { code: 'B11', description: 'Yeast / Flavour / Bread Crumbs / Rice Flour / Flour',
    categories: ['yeast', 'baking yeast', 'artificial flavour', 'food coloring',
                 'bread crumbs', 'panko', 'rice flour', 'glutinous rice flour',
                 'wheat flour', 'all-purpose flour', 'tapioca flour',
                 '酵母', '香精', '面包糠', '米粉', '糯米粉', '面粉'] },
];

// ─── C 区 (中央) ───
// No predefined categories — populated by whatever products are scanned.
const CENTER_SHELVES: ShelfLocation[] = [
  { code: 'C1',  description: 'Center column top / 中央纵列①',      categories: [] },
  { code: 'C2',  description: 'Center column upper / 中央纵列②',    categories: [] },
  { code: 'C3',  description: 'Center column lower / 中央纵列③',    categories: [] },
  { code: 'C4',  description: 'Center column bottom / 中央纵列④',   categories: [] },
  { code: 'XB1', description: 'Cross aisle B left / 横道B左',        categories: [] },
  { code: 'XB2', description: 'Cross aisle B right / 横道B右',       categories: [] },
  { code: 'CX',  description: 'Center crossroads / 十字中心',        categories: [] },
  { code: 'XA1', description: 'Cross aisle A left / 横道A左',        categories: [] },
  { code: 'XA2', description: 'Cross aisle A right / 横道A右',       categories: [] },
  // Front-of-store coolers — top shelf above the fridges (not in the A/B grid).
  { code: 'CoolerTop', description: '冷柜顶 / Cooler top', categories: [] },
];

// B6, A6, A12 have no side faces in the store map
const NO_SIDES = new Set(['B6', 'A6', 'A12']);

const SHELF_SIDES: ShelfLocation[] = MAIN_SHELVES
  .filter(s => !NO_SIDES.has(s.code))
  .flatMap(s => [
    { code: `L${s.code}`, description: `Left · ${s.description}`, categories: s.categories },
    { code: `R${s.code}`, description: `Right · ${s.description}`, categories: s.categories },
  ]);

export const SHELVES: ShelfLocation[] = [...MAIN_SHELVES, ...SHELF_SIDES, ...CENTER_SHELVES];

export const SHELF_CODES = SHELVES.map(s => s.code);

const SHELF_BY_CODE = new Map(SHELVES.map(s => [s.code, s]));

export function getShelf(code: string): ShelfLocation | undefined {
  return SHELF_BY_CODE.get(code);
}

/**
 * Compact one-line context string ready to drop into an LLM prompt.
 *   buildShelfContext("B6") -> "B6 — Instant Noodles. Likely products: instant noodles, instant ramen, cup noodle, ..."
 */
export function buildShelfContext(code: string): string {
  const s = SHELF_BY_CODE.get(code);
  if (!s) return code;
  const likely = s.categories.length > 0
    ? ` Likely products: ${s.categories.slice(0, 12).join(', ')}.`
    : '';
  return `${s.code} — ${s.description}.${likely}`;
}
