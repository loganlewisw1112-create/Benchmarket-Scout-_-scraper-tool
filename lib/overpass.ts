export type OsmTagPair = [string, string];

/**
 * How an industry string was resolved to OSM tags. Staged resolution runs in
 * order and the first stage that yields tags wins:
 *   - "map":   the normalized string (whole or a word / word-pair inside it)
 *              matched a curated keyword in {@link OSM_CATEGORY_MAP}.
 *   - "probe": no keyword matched, so the remaining meaningful words are tried
 *              as literal OSM tag values across the common feature keys.
 *   - "none":  the honest floor — nothing usable to query. Callers should NOT
 *              fabricate competitors; they fall back to clearly-labeled demo
 *              rows and a data-quality note naming the unmatched industry.
 */
export type ResolutionStage = "map" | "probe" | "none";

export interface IndustryResolution {
  tags: OsmTagPair[];
  stage: ResolutionStage;
  /** The keyword / token(s) that produced the resolution, for diagnostics. */
  matched: string | null;
}

/**
 * Curated keyword -> OSM tag map. Keys are normalized (lowercase, single
 * spaces). Values are OSM key/value pairs that identify that kind of business
 * as a live map feature. Synonyms deliberately point at the same tags so token
 * matching has many entry points. This is intentionally broad (~200 keys) but
 * does NOT need to be exhaustive: the direct-tag probe (stage "probe") catches
 * the long tail without any map maintenance.
 */
export const OSM_CATEGORY_MAP: Record<string, OsmTagPair[]> = {
  // ---- Food & drink -------------------------------------------------------
  restaurant: [["amenity", "restaurant"]],
  diner: [["amenity", "restaurant"]],
  bistro: [["amenity", "restaurant"]],
  eatery: [["amenity", "restaurant"]],
  pizzeria: [
    ["amenity", "restaurant"],
    ["amenity", "fast_food"],
  ],
  pizza: [
    ["amenity", "restaurant"],
    ["amenity", "fast_food"],
  ],
  cafe: [["amenity", "cafe"]],
  coffee: [["amenity", "cafe"]],
  "coffee shop": [["amenity", "cafe"]],
  coffeehouse: [["amenity", "cafe"]],
  teahouse: [
    ["amenity", "cafe"],
    ["shop", "tea"],
  ],
  bar: [
    ["amenity", "bar"],
    ["amenity", "pub"],
  ],
  pub: [
    ["amenity", "pub"],
    ["amenity", "bar"],
  ],
  tavern: [
    ["amenity", "pub"],
    ["amenity", "bar"],
  ],
  "fast food": [["amenity", "fast_food"]],
  takeaway: [["amenity", "fast_food"]],
  takeout: [["amenity", "fast_food"]],
  "food truck": [["amenity", "fast_food"]],
  "juice bar": [["amenity", "fast_food"]],
  bakery: [
    ["shop", "bakery"],
    ["craft", "bakery"],
  ],
  baker: [
    ["shop", "bakery"],
    ["craft", "bakery"],
  ],
  patisserie: [["shop", "pastry"]],
  deli: [["shop", "deli"]],
  delicatessen: [["shop", "deli"]],
  butcher: [
    ["shop", "butcher"],
    ["craft", "butcher"],
  ],
  brewery: [["craft", "brewery"]],
  brewpub: [
    ["craft", "brewery"],
    ["amenity", "pub"],
  ],
  winery: [["craft", "winery"]],
  distillery: [["craft", "distillery"]],
  caterer: [["craft", "caterer"]],
  catering: [["craft", "caterer"]],
  "ice cream": [
    ["amenity", "ice_cream"],
    ["shop", "ice_cream"],
  ],
  confectionery: [
    ["shop", "confectionery"],
    ["craft", "confectionery"],
  ],
  candy: [["shop", "confectionery"]],
  chocolate: [
    ["shop", "chocolate"],
    ["shop", "confectionery"],
  ],
  grocery: [
    ["shop", "supermarket"],
    ["shop", "convenience"],
  ],
  "grocery store": [
    ["shop", "supermarket"],
    ["shop", "convenience"],
  ],
  supermarket: [["shop", "supermarket"]],
  convenience: [["shop", "convenience"]],
  greengrocer: [["shop", "greengrocer"]],
  produce: [["shop", "greengrocer"]],
  "farmers market": [["amenity", "marketplace"]],
  "farm shop": [["shop", "farm"]],
  tea: [["shop", "tea"]],

  // ---- Health & medical ---------------------------------------------------
  dentist: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  dental: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  orthodontist: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  doctor: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  doctors: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  physician: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  medical: [
    ["amenity", "doctors"],
    ["amenity", "clinic"],
    ["healthcare", "doctor"],
  ],
  clinic: [
    ["amenity", "clinic"],
    ["healthcare", "clinic"],
    ["amenity", "doctors"],
  ],
  pediatrician: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  dermatologist: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  hospital: [
    ["amenity", "hospital"],
    ["healthcare", "hospital"],
  ],
  pharmacy: [
    ["amenity", "pharmacy"],
    ["healthcare", "pharmacy"],
  ],
  drugstore: [
    ["amenity", "pharmacy"],
    ["shop", "chemist"],
  ],
  chemist: [
    ["shop", "chemist"],
    ["amenity", "pharmacy"],
  ],
  optician: [
    ["shop", "optician"],
    ["healthcare", "optometrist"],
  ],
  optometrist: [
    ["shop", "optician"],
    ["healthcare", "optometrist"],
  ],
  optical: [["shop", "optician"]],
  eyewear: [["shop", "optician"]],
  veterinary: [
    ["amenity", "veterinary"],
    ["healthcare", "veterinary"],
  ],
  veterinarian: [
    ["amenity", "veterinary"],
    ["healthcare", "veterinary"],
  ],
  vet: [
    ["amenity", "veterinary"],
    ["healthcare", "veterinary"],
  ],
  physiotherapy: [["healthcare", "physiotherapist"]],
  physiotherapist: [["healthcare", "physiotherapist"]],
  "physical therapy": [["healthcare", "physiotherapist"]],
  physio: [["healthcare", "physiotherapist"]],
  chiropractor: [["healthcare", "chiropractor"]],
  chiropractic: [["healthcare", "chiropractor"]],
  psychologist: [["healthcare", "psychotherapist"]],
  psychology: [["healthcare", "psychotherapist"]],
  psychotherapist: [["healthcare", "psychotherapist"]],
  therapist: [["healthcare", "psychotherapist"]],
  counseling: [["healthcare", "psychotherapist"]],
  counselling: [["healthcare", "psychotherapist"]],
  "mental health": [["healthcare", "psychotherapist"]],
  podiatrist: [["healthcare", "podiatrist"]],
  dietitian: [["healthcare", "dietitian"]],
  nutritionist: [["healthcare", "dietitian"]],
  midwife: [["healthcare", "midwife"]],
  audiologist: [
    ["healthcare", "audiologist"],
    ["shop", "hearing_aids"],
  ],
  acupuncture: [["healthcare", "alternative"]],
  "alternative medicine": [["healthcare", "alternative"]],
  "nursing home": [["amenity", "nursing_home"]],
  "assisted living": [["amenity", "nursing_home"]],
  rehabilitation: [["healthcare", "rehabilitation"]],

  // ---- Personal care ------------------------------------------------------
  salon: [
    ["shop", "hairdresser"],
    ["shop", "beauty"],
  ],
  "hair salon": [
    ["shop", "hairdresser"],
    ["shop", "beauty"],
  ],
  hairdresser: [["shop", "hairdresser"]],
  hair: [
    ["shop", "hairdresser"],
    ["shop", "beauty"],
  ],
  barber: [["shop", "hairdresser"]],
  "barber shop": [["shop", "hairdresser"]],
  beauty: [
    ["shop", "beauty"],
    ["shop", "cosmetics"],
  ],
  "beauty salon": [
    ["shop", "beauty"],
    ["shop", "cosmetics"],
  ],
  cosmetics: [
    ["shop", "cosmetics"],
    ["shop", "beauty"],
  ],
  spa: [
    ["leisure", "spa"],
    ["shop", "beauty"],
  ],
  "day spa": [
    ["leisure", "spa"],
    ["shop", "beauty"],
  ],
  nail: [["shop", "beauty"]],
  "nail salon": [["shop", "beauty"]],
  manicure: [["shop", "beauty"]],
  massage: [["shop", "massage"]],
  tattoo: [["shop", "tattoo"]],
  "tattoo parlor": [["shop", "tattoo"]],
  piercing: [["shop", "tattoo"]],
  tanning: [["shop", "beauty"]],

  // ---- Trades (craft=*) ---------------------------------------------------
  plumber: [["craft", "plumber"]],
  plumbing: [["craft", "plumber"]],
  electrician: [["craft", "electrician"]],
  electrical: [["craft", "electrician"]],
  carpenter: [["craft", "carpenter"]],
  carpentry: [["craft", "carpenter"]],
  joiner: [["craft", "carpenter"]],
  painter: [["craft", "painter"]],
  painting: [["craft", "painter"]],
  decorator: [["craft", "painter"]],
  roofer: [["craft", "roofer"]],
  roofing: [["craft", "roofer"]],
  gutter: [["craft", "roofer"]],
  builder: [["craft", "builder"]],
  construction: [["craft", "builder"]],
  contractor: [["craft", "builder"]],
  "general contractor": [["craft", "builder"]],
  handyman: [
    ["craft", "builder"],
    ["craft", "carpenter"],
  ],
  hvac: [
    ["craft", "hvac"],
    ["craft", "heating_engineer"],
  ],
  heating: [
    ["craft", "hvac"],
    ["craft", "heating_engineer"],
  ],
  "air conditioning": [["craft", "hvac"]],
  landscaping: [
    ["craft", "gardener"],
    ["office", "landscape_architect"],
    ["shop", "garden_centre"],
  ],
  landscaper: [
    ["craft", "gardener"],
    ["office", "landscape_architect"],
    ["shop", "garden_centre"],
  ],
  gardener: [["craft", "gardener"]],
  gardening: [["craft", "gardener"]],
  "lawn care": [["craft", "gardener"]],
  mason: [["craft", "stonemason"]],
  masonry: [["craft", "stonemason"]],
  stonemason: [["craft", "stonemason"]],
  bricklayer: [["craft", "stonemason"]],
  welder: [["craft", "welder"]],
  welding: [["craft", "welder"]],
  blacksmith: [["craft", "blacksmith"]],
  metalworker: [["craft", "metal_construction"]],
  locksmith: [
    ["craft", "locksmith"],
    ["shop", "locksmith"],
  ],
  glazier: [["craft", "glaziery"]],
  glazing: [["craft", "glaziery"]],
  tiler: [["craft", "tiler"]],
  tiling: [["craft", "tiler"]],
  plasterer: [["craft", "plasterer"]],
  plastering: [["craft", "plasterer"]],
  flooring: [
    ["craft", "floorer"],
    ["shop", "flooring"],
  ],
  floorer: [["craft", "floorer"]],
  insulation: [["craft", "insulation"]],
  scaffolder: [["craft", "scaffolder"]],
  scaffolding: [["craft", "scaffolder"]],
  "chimney sweep": [["craft", "chimney_sweeper"]],
  "pest control": [["craft", "pest_control"]],
  exterminator: [["craft", "pest_control"]],
  sign: [["craft", "signmaker"]],
  signage: [["craft", "signmaker"]],
  signmaker: [["craft", "signmaker"]],
  upholsterer: [["craft", "upholsterer"]],
  upholstery: [["craft", "upholsterer"]],
  solar: [["craft", "electrician"]],
  "appliance repair": [
    ["craft", "electronics_repair"],
    ["shop", "appliance"],
  ],
  "electronics repair": [["craft", "electronics_repair"]],
  "phone repair": [
    ["craft", "electronics_repair"],
    ["shop", "mobile_phone"],
  ],
  "computer repair": [
    ["craft", "electronics_repair"],
    ["shop", "computer"],
  ],
  watchmaker: [["craft", "watchmaker"]],
  clockmaker: [["craft", "clockmaker"]],
  jeweler: [
    ["shop", "jewelry"],
    ["craft", "jeweller"],
  ],
  jeweller: [
    ["shop", "jewelry"],
    ["craft", "jeweller"],
  ],
  jewelry: [["shop", "jewelry"]],
  jewellery: [["shop", "jewelry"]],
  tailor: [
    ["craft", "tailor"],
    ["shop", "tailor"],
  ],
  seamstress: [["craft", "dressmaker"]],
  dressmaker: [["craft", "dressmaker"]],
  alterations: [["craft", "tailor"]],
  cobbler: [
    ["craft", "shoemaker"],
    ["shop", "shoe_repair"],
  ],
  shoemaker: [["craft", "shoemaker"]],
  "shoe repair": [["shop", "shoe_repair"]],
  photographer: [["craft", "photographer"]],
  photography: [["craft", "photographer"]],
  printer: [
    ["craft", "printer"],
    ["shop", "copyshop"],
  ],
  printing: [
    ["craft", "printer"],
    ["shop", "copyshop"],
  ],
  "print shop": [["shop", "copyshop"]],
  florist: [["shop", "florist"]],
  florist_shop: [["shop", "florist"]],
  flowers: [["shop", "florist"]],
  floristry: [["shop", "florist"]],
  pottery: [["craft", "pottery"]],
  potter: [["craft", "pottery"]],
  ceramics: [["craft", "pottery"]],
  cabinetmaker: [["craft", "cabinet_maker"]],
  "furniture maker": [["craft", "cabinet_maker"]],
  sawmill: [["craft", "sawmill"]],
  saddler: [["craft", "saddler"]],
  bookbinder: [["craft", "bookbinder"]],

  // ---- Professional services (office=*) -----------------------------------
  lawyer: [["office", "lawyer"]],
  attorney: [["office", "lawyer"]],
  "law firm": [["office", "lawyer"]],
  legal: [["office", "lawyer"]],
  solicitor: [["office", "lawyer"]],
  notary: [["office", "notary"]],
  accountant: [
    ["office", "accountant"],
    ["office", "tax_advisor"],
  ],
  accounting: [
    ["office", "accountant"],
    ["office", "tax_advisor"],
  ],
  cpa: [["office", "accountant"]],
  bookkeeper: [["office", "accountant"]],
  bookkeeping: [["office", "accountant"]],
  "tax advisor": [["office", "tax_advisor"]],
  "tax preparation": [["office", "tax_advisor"]],
  "financial advisor": [
    ["office", "financial_advisor"],
    ["office", "financial"],
  ],
  "financial planner": [
    ["office", "financial_advisor"],
    ["office", "financial"],
  ],
  "financial services": [["office", "financial"]],
  insurance: [["office", "insurance"]],
  "insurance agency": [["office", "insurance"]],
  "real estate": [["office", "estate_agent"]],
  realestate: [["office", "estate_agent"]],
  realtor: [["office", "estate_agent"]],
  "estate agent": [["office", "estate_agent"]],
  "property management": [["office", "estate_agent"]],
  architect: [["office", "architect"]],
  architecture: [["office", "architect"]],
  engineer: [["office", "engineer"]],
  engineering: [["office", "engineer"]],
  surveyor: [["office", "surveyor"]],
  surveying: [["office", "surveyor"]],
  consultant: [["office", "consulting"]],
  consulting: [["office", "consulting"]],
  "it services": [
    ["office", "it"],
    ["office", "telecommunication"],
  ],
  "it support": [["office", "it"]],
  software: [["office", "it"]],
  "software development": [["office", "it"]],
  "web design": [["office", "it"]],
  "web development": [["office", "it"]],
  "digital agency": [
    ["office", "it"],
    ["office", "advertising_agency"],
  ],
  marketing: [["office", "advertising_agency"]],
  "marketing agency": [["office", "advertising_agency"]],
  advertising: [["office", "advertising_agency"]],
  "graphic design": [["office", "graphic_design"]],
  "employment agency": [["office", "employment_agency"]],
  staffing: [["office", "employment_agency"]],
  recruiter: [["office", "employment_agency"]],
  recruitment: [["office", "employment_agency"]],
  "travel agency": [
    ["shop", "travel_agency"],
    ["office", "travel_agent"],
  ],
  "travel agent": [
    ["shop", "travel_agency"],
    ["office", "travel_agent"],
  ],
  coworking: [["office", "coworking"]],
  logistics: [["office", "logistics"]],
  freight: [["office", "logistics"]],
  "moving company": [["office", "moving_company"]],
  mover: [["office", "moving_company"]],
  removals: [["office", "moving_company"]],
  "funeral home": [["shop", "funeral_directors"]],
  funeral: [["shop", "funeral_directors"]],
  undertaker: [["shop", "funeral_directors"]],
  "interior design": [["shop", "interior_decoration"]],
  "interior designer": [["shop", "interior_decoration"]],

  // ---- Cleaning & home services -------------------------------------------
  cleaning: [["craft", "cleaning"]],
  "cleaning service": [["craft", "cleaning"]],
  cleaner: [["craft", "cleaning"]],
  janitorial: [["craft", "cleaning"]],
  "maid service": [["craft", "cleaning"]],
  "carpet cleaning": [["craft", "cleaning"]],
  "window cleaning": [["craft", "cleaning"]],
  laundry: [
    ["shop", "laundry"],
    ["shop", "dry_cleaning"],
  ],
  laundromat: [["shop", "laundry"]],
  launderette: [["shop", "laundry"]],
  "dry cleaning": [["shop", "dry_cleaning"]],
  "dry cleaner": [["shop", "dry_cleaning"]],
  "self storage": [["shop", "storage_rental"]],
  storage: [["shop", "storage_rental"]],

  // ---- Retail -------------------------------------------------------------
  clothing: [["shop", "clothes"]],
  "clothing store": [["shop", "clothes"]],
  apparel: [["shop", "clothes"]],
  boutique: [["shop", "clothes"]],
  fashion: [["shop", "clothes"]],
  shoes: [["shop", "shoes"]],
  "shoe store": [["shop", "shoes"]],
  footwear: [["shop", "shoes"]],
  bookstore: [["shop", "books"]],
  "book shop": [["shop", "books"]],
  books: [["shop", "books"]],
  hardware: [
    ["shop", "hardware"],
    ["shop", "doityourself"],
  ],
  "hardware store": [
    ["shop", "hardware"],
    ["shop", "doityourself"],
  ],
  electronics: [["shop", "electronics"]],
  "electronics store": [["shop", "electronics"]],
  "mobile phone": [["shop", "mobile_phone"]],
  "phone store": [["shop", "mobile_phone"]],
  computer: [["shop", "computer"]],
  "computer store": [["shop", "computer"]],
  furniture: [["shop", "furniture"]],
  "furniture store": [["shop", "furniture"]],
  "home decor": [
    ["shop", "interior_decoration"],
    ["shop", "furniture"],
  ],
  "pet store": [["shop", "pet"]],
  "pet shop": [["shop", "pet"]],
  pet: [["shop", "pet"]],
  "toy store": [["shop", "toys"]],
  toys: [["shop", "toys"]],
  "sporting goods": [["shop", "sports"]],
  "sports store": [["shop", "sports"]],
  "bike shop": [["shop", "bicycle"]],
  bicycle: [["shop", "bicycle"]],
  bikes: [["shop", "bicycle"]],
  "liquor store": [
    ["shop", "alcohol"],
    ["shop", "wine"],
  ],
  liquor: [["shop", "alcohol"]],
  "wine shop": [["shop", "wine"]],
  "off licence": [["shop", "alcohol"]],
  "gift shop": [["shop", "gift"]],
  gifts: [["shop", "gift"]],
  souvenir: [["shop", "gift"]],
  "thrift store": [
    ["shop", "charity"],
    ["shop", "second_hand"],
  ],
  "charity shop": [["shop", "charity"]],
  consignment: [["shop", "second_hand"]],
  antiques: [["shop", "antiques"]],
  "art gallery": [
    ["shop", "art"],
    ["tourism", "gallery"],
  ],
  gallery: [
    ["shop", "art"],
    ["tourism", "gallery"],
  ],
  "music store": [
    ["shop", "musical_instrument"],
    ["shop", "music"],
  ],
  "musical instruments": [["shop", "musical_instrument"]],
  "record store": [["shop", "music"]],
  stationery: [["shop", "stationery"]],
  "office supplies": [["shop", "stationery"]],
  "department store": [["shop", "department_store"]],
  mattress: [["shop", "bed"]],
  "appliance store": [["shop", "appliance"]],
  appliances: [["shop", "appliance"]],
  tobacco: [["shop", "tobacco"]],
  "vape shop": [
    ["shop", "e-cigarette"],
    ["shop", "tobacco"],
  ],
  vape: [["shop", "e-cigarette"]],
  cannabis: [["shop", "cannabis"]],
  dispensary: [["shop", "cannabis"]],
  "pawn shop": [["shop", "pawnbroker"]],
  fabric: [["shop", "fabric"]],
  "craft store": [["shop", "craft"]],
  "garden centre": [["shop", "garden_centre"]],
  "garden center": [["shop", "garden_centre"]],

  // ---- Automotive ---------------------------------------------------------
  "auto repair": [["shop", "car_repair"]],
  "car repair": [["shop", "car_repair"]],
  mechanic: [["shop", "car_repair"]],
  "auto shop": [["shop", "car_repair"]],
  garage: [["shop", "car_repair"]],
  "auto body": [["shop", "car_repair"]],
  "body shop": [["shop", "car_repair"]],
  collision: [["shop", "car_repair"]],
  "oil change": [["shop", "car_repair"]],
  "auto detailing": [
    ["shop", "car_repair"],
    ["amenity", "car_wash"],
  ],
  "car dealer": [["shop", "car"]],
  "car dealership": [["shop", "car"]],
  dealership: [["shop", "car"]],
  "used cars": [["shop", "car"]],
  "tire shop": [["shop", "tyres"]],
  tires: [["shop", "tyres"]],
  tyres: [["shop", "tyres"]],
  "auto parts": [["shop", "car_parts"]],
  "car parts": [["shop", "car_parts"]],
  "gas station": [["amenity", "fuel"]],
  "petrol station": [["amenity", "fuel"]],
  fuel: [["amenity", "fuel"]],
  motorcycle: [["shop", "motorcycle"]],
  "car rental": [["amenity", "car_rental"]],
  "auto glass": [
    ["craft", "glaziery"],
    ["shop", "car_repair"],
  ],
  "ev charging": [["amenity", "charging_station"]],
  "charging station": [["amenity", "charging_station"]],

  // ---- Fitness & leisure --------------------------------------------------
  gym: [
    ["leisure", "fitness_centre"],
    ["leisure", "sports_centre"],
  ],
  fitness: [
    ["leisure", "fitness_centre"],
    ["leisure", "sports_centre"],
  ],
  "fitness center": [["leisure", "fitness_centre"]],
  "health club": [["leisure", "fitness_centre"]],
  yoga: [["leisure", "fitness_centre"]],
  "yoga studio": [["leisure", "fitness_centre"]],
  pilates: [["leisure", "fitness_centre"]],
  crossfit: [["leisure", "fitness_centre"]],
  "personal trainer": [["leisure", "fitness_centre"]],
  "martial arts": [["leisure", "sports_centre"]],
  karate: [["leisure", "sports_centre"]],
  dojo: [["leisure", "sports_centre"]],
  "swimming pool": [["leisure", "swimming_pool"]],
  "golf course": [["leisure", "golf_course"]],
  golf: [["leisure", "golf_course"]],
  "bowling alley": [["leisure", "bowling_alley"]],
  bowling: [["leisure", "bowling_alley"]],
  "dance studio": [["leisure", "dance"]],
  dance: [["leisure", "dance"]],

  // ---- Education & childcare ----------------------------------------------
  childcare: [["amenity", "childcare"]],
  daycare: [
    ["amenity", "childcare"],
    ["amenity", "kindergarten"],
  ],
  "day care": [
    ["amenity", "childcare"],
    ["amenity", "kindergarten"],
  ],
  nursery: [["amenity", "kindergarten"]],
  preschool: [["amenity", "kindergarten"]],
  kindergarten: [["amenity", "kindergarten"]],
  school: [["amenity", "school"]],
  academy: [["amenity", "school"]],
  college: [["amenity", "college"]],
  university: [["amenity", "university"]],
  tutoring: [["amenity", "prep_school"]],
  tutor: [["amenity", "prep_school"]],
  "driving school": [["amenity", "driving_school"]],
  "music school": [["amenity", "music_school"]],
  "language school": [["amenity", "language_school"]],

  // ---- Lodging & hospitality ----------------------------------------------
  hotel: [
    ["tourism", "hotel"],
    ["tourism", "motel"],
  ],
  motel: [["tourism", "motel"]],
  inn: [
    ["tourism", "hotel"],
    ["tourism", "guest_house"],
  ],
  lodging: [
    ["tourism", "hotel"],
    ["tourism", "guest_house"],
  ],
  resort: [["tourism", "hotel"]],
  "bed and breakfast": [["tourism", "guest_house"]],
  guesthouse: [["tourism", "guest_house"]],
  hostel: [["tourism", "hostel"]],
  "vacation rental": [["tourism", "guest_house"]],
  campground: [
    ["tourism", "camp_site"],
    ["tourism", "caravan_site"],
  ],
  "rv park": [["tourism", "caravan_site"]],

  // ---- Pets ---------------------------------------------------------------
  "pet grooming": [["shop", "pet_grooming"]],
  "dog grooming": [["shop", "pet_grooming"]],
  groomer: [["shop", "pet_grooming"]],
  kennel: [["amenity", "animal_boarding"]],
  "pet boarding": [["amenity", "animal_boarding"]],
};

/**
 * Generic words that must never drive a match or a probe. They appear in
 * almost any business name ("dental office", "cleaning services company") and
 * would otherwise hijack resolution toward useless tags like `office=office`.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "my",
  "your",
  "me",
  "near",
  "best",
  "local",
  "top",
  "affordable",
  "premier",
  "quality",
  "shop",
  "store",
  "stores",
  "service",
  "services",
  "svc",
  "company",
  "co",
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "office",
  "offices",
  "center",
  "centre",
  "group",
  "professional",
  "professionals",
  "business",
  "solutions",
  "solution",
  "provider",
  "providers",
]);

/**
 * OSM feature keys tried, in order, when probing an unmatched word as a literal
 * tag value. Ordered most-specific-first so the honest floor still surfaces the
 * best guess when the clause budget is tight.
 */
const PROBE_KEYS = ["shop", "craft", "amenity", "office", "leisure", "healthcare"] as const;

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Resolve a free-text industry string to OSM tag pairs using staged resolution.
 *
 * Stage 1 (map): the normalized whole string, then every contiguous word-pair /
 *   word-triple (longest first, "most specific wins"), then individual words are
 *   checked against {@link OSM_CATEGORY_MAP}. Stopwords are ignored for
 *   single-word matching so "family dental office" resolves via "dental".
 * Stage 2 (probe): with no keyword hit, the remaining meaningful words (and the
 *   underscored phrase, e.g. "car wash" -> "car_wash") are emitted as literal
 *   values across {@link PROBE_KEYS}, catching the long tail without map upkeep.
 * Stage 3 (none): nothing meaningful to query. Tags are empty; the caller must
 *   fall back to labeled demo rows rather than fabricate competitors.
 */
export function resolveIndustry(businessType: string): IndustryResolution {
  const tokens = normalizeTokens(businessType);

  if (tokens.length === 0) {
    return { tags: [], stage: "none", matched: null };
  }

  const full = tokens.join(" ");
  if (OSM_CATEGORY_MAP[full]) {
    return { tags: OSM_CATEGORY_MAP[full], stage: "map", matched: full };
  }

  // Contiguous multi-word phrases, longest window first (most specific wins).
  for (let window = Math.min(3, tokens.length); window >= 2; window--) {
    for (let start = 0; start + window <= tokens.length; start++) {
      const phrase = tokens.slice(start, start + window).join(" ");
      if (OSM_CATEGORY_MAP[phrase]) {
        return { tags: OSM_CATEGORY_MAP[phrase], stage: "map", matched: phrase };
      }
    }
  }

  // Individual, non-generic words.
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    if (OSM_CATEGORY_MAP[token]) {
      return { tags: OSM_CATEGORY_MAP[token], stage: "map", matched: token };
    }
  }

  // Stage 2: direct tag probe over the meaningful words.
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  if (meaningful.length === 0) {
    return { tags: [], stage: "none", matched: null };
  }

  const probeValues: string[] = [];
  if (meaningful.length > 1) probeValues.push(meaningful.join("_"));
  for (const token of meaningful) probeValues.push(token);

  const seen = new Set<string>();
  const tags: OsmTagPair[] = [];
  for (const value of probeValues) {
    for (const key of PROBE_KEYS) {
      const dedupeKey = `${key}=${value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tags.push([key, value]);
    }
  }

  return { tags, stage: "probe", matched: meaningful.join(" ") };
}

/**
 * Backwards-compatible helper: the OSM tag pairs for an industry string, or an
 * empty array when resolution hits the honest floor (stage "none").
 */
export function resolveOsmTags(businessType: string): OsmTagPair[] {
  return resolveIndustry(businessType).tags;
}

export type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

// The public Overpass API is known to be intermittently flaky (occasional
// 504s under load even when the service is generally up). We retry the
// primary endpoint a couple of times before spreading attempts across
// alternate public mirrors, rather than giving up on the first failure.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const ATTEMPTS_PER_ENDPOINT = 2;
const PER_REQUEST_TIMEOUT_MS = 15000;
const RETRY_BACKOFF_MS = 800;

// Staged resolution (esp. the direct-tag probe) can produce many candidate tag
// clauses. Cap them so a single Overpass request stays polite and fast; the
// probe orders clauses most-specific-first, so the cap keeps the best guesses.
const MAX_TAG_CLAUSES = 24;
// Element cap in the `out` statement. Broadened queries now span several tags,
// so we pull a slightly larger candidate pool for downstream ranking/dedupe
// while still keeping the response small.
const OUTPUT_LIMIT = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverpassOnce(
  endpoint: string,
  query: string
): Promise<OverpassElement[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Overpass (${endpoint}) returned HTTP ${res.status}`);
    }

    const text = await res.text();
    let data: { elements?: OverpassElement[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Overpass (${endpoint}) returned a non-JSON response`);
    }

    return data.elements ?? [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryOverpass(
  businessType: string,
  lat: number,
  lon: number,
  radiusMeters = 12000
): Promise<OverpassElement[]> {
  const tagPairs = resolveOsmTags(businessType);

  // Honest floor: nothing resolved to a live OSM tag, so there is nothing to
  // query. Return no elements rather than firing a near-dead `shop=yes` query;
  // the caller then surfaces labeled demo rows and a data-quality note.
  if (tagPairs.length === 0) {
    return [];
  }

  const clauses = tagPairs
    .slice(0, MAX_TAG_CLAUSES)
    .map(
      ([key, value]) =>
        `nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lon});`
    )
    .join("\n  ");

  const query = `[out:json][timeout:25];
(
  ${clauses}
);
out center tags ${OUTPUT_LIMIT};`;

  let lastError: unknown;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
      try {
        return await fetchOverpassOnce(endpoint, query);
      } catch (err) {
        lastError = err;
        const isLastAttemptOnEndpoint = attempt === ATTEMPTS_PER_ENDPOINT;
        if (!isLastAttemptOnEndpoint) {
          await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Overpass discovery failed across all endpoints and retries");
}
