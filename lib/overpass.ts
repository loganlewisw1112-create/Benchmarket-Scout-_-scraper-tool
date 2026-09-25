import { CACHE_TTL, readCacheEntry, writeCache } from "./cache";
import { logger, serializeError } from "./logger";
import { SourceUnavailableError } from "./pipeline-errors";
import {
  abortableDelay,
  createTimedSignal,
  remainingBudgetMs,
  type RequestBudgetOptions,
} from "./time-budget";

export type OsmTagPair = [string, string];

/**
 * How an industry string was resolved to OSM tags. Staged resolution runs in
 * order and the first stage that yields tags wins:
 *   - "map":   the normalized string (whole or a word / word-pair inside it)
 *              matched a curated keyword in {@link OSM_CATEGORY_MAP}.
 *   - "probe": no keyword matched, so the remaining meaningful words are tried
 *              as literal OSM tag values across the common feature keys. A
 *              probe with zero hits means "not understood", not "no rivals".
 *   - "none":  the honest floor — nothing usable to query. Callers must not
 *              fabricate competitors; they stop with INDUSTRY_NOT_RESOLVED.
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
 * the long tail without any map maintenance. An entry with an empty tag list
 * marks a known dead end (see the end of the map).
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
  // Specific "<x> bar" venues; the bare head noun "bar" would pick pubs.
  "sushi bar": [["amenity", "restaurant"]],
  "oyster bar": [["amenity", "restaurant"]],
  "espresso bar": [["amenity", "cafe"]],
  "coffee bar": [["amenity", "cafe"]],
  "nail bar": [["shop", "beauty"]],
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
    ["shop", "chemist"],
  ],
  drugstore: [
    ["amenity", "pharmacy"],
    ["shop", "chemist"],
  ],
  "drug store": [
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
  // Barbers are shop=hairdresser + hairdresser=barber (OSM wiki; ~16k uses on
  // taginfo 2026-09-24). The subtag alone selects them without every salon.
  barber: [["hairdresser", "barber"]],
  barbers: [["hairdresser", "barber"]],
  barbershop: [["hairdresser", "barber"]],
  "barber shop": [["hairdresser", "barber"]],
  barbering: [["hairdresser", "barber"]],
  "hair removal": [["shop", "beauty"]],
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
  "tattoo studio": [["shop", "tattoo"]],
  "tattoo shop": [["shop", "tattoo"]],
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
  // Landscaping contractors are craft=gardener (wiki: "landscape gardener";
  // ~7.5k uses on taginfo 2026-09-24);
  // craft=landscaper is rare but unambiguous. Garden centres are plant
  // retailers, not landscapers, and filled 6/10 slots in a live sample.
  landscaping: [
    ["craft", "gardener"],
    ["craft", "landscaper"],
  ],
  landscaper: [
    ["craft", "gardener"],
    ["craft", "landscaper"],
  ],
  landscape: [
    ["craft", "gardener"],
    ["craft", "landscaper"],
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
  "book store": [["shop", "books"]],
  "book shop": [["shop", "books"]],
  bookshop: [["shop", "books"]],
  books: [["shop", "books"]],
  book: [["shop", "books"]],
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
  // Detailers: service:vehicle:detailing=yes (wiki-documented, ~380 uses) plus
  // car washes, which commonly offer detailing. Repair shops and parts stores
  // are a different trade.
  "auto detailing": [
    ["service:vehicle:detailing", "yes"],
    ["amenity", "car_wash"],
  ],
  "car detailing": [
    ["service:vehicle:detailing", "yes"],
    ["amenity", "car_wash"],
  ],
  "mobile detailing": [
    ["service:vehicle:detailing", "yes"],
    ["amenity", "car_wash"],
  ],
  detailing: [
    ["service:vehicle:detailing", "yes"],
    ["amenity", "car_wash"],
  ],
  detailer: [
    ["service:vehicle:detailing", "yes"],
    ["amenity", "car_wash"],
  ],
  "car wash": [["amenity", "car_wash"]],
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
  // Yoga studios carry sport=yoga (~7.6k uses on taginfo 2026-09-24);
  // leisure=fitness_centre alone returned general gyms and CrossFit boxes.
  yoga: [["sport", "yoga"]],
  "yoga studio": [["sport", "yoga"]],
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
  // Escape rooms are leisure=escape_game (OSM wiki; ~3.2k uses on taginfo
  // 2026-09-24), not the generic amusement/sports tags.
  "escape room": [["leisure", "escape_game"]],
  "escape rooms": [["leisure", "escape_game"]],
  "escape game": [["leisure", "escape_game"]],

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
  "pet groomer": [["shop", "pet_grooming"]],
  kennel: [["amenity", "animal_boarding"]],
  "pet boarding": [["amenity", "animal_boarding"]],

  // ---- Known dead ends ----------------------------------------------------
  // Phrases whose head or modifier word would otherwise hit an unrelated
  // category ("garage door repair" -> car repair, "cooking school" -> K-12
  // school, "sign language interpreter" -> sign maker, "pet sitting" -> pet
  // store). OSM has no reliable tag for these, so they resolve to nothing and
  // the analysis stops with INDUSTRY_NOT_RESOLVED instead of benchmarking a
  // different trade.
  "garage door": [],
  "sign language": [],
  "pet sitting": [],
  "pet sitter": [],
  "dog walker": [],
  "dog walking": [],
  "swim school": [],
  "swimming lessons": [],
  "art school": [],
  "cooking school": [],
  "cooking class": [],
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
 *   checked against {@link OSM_CATEGORY_MAP}. Single words are tried from the
 *   END of the phrase first, because English puts the head noun last: "pet
 *   groomer" is a groomer, not a pet store. Stopwords are ignored for
 *   single-word matching so "family dental office" resolves via "dental".
 *   A map entry with no tags is a known dead end and resolves to "none".
 * Stage 2 (probe): with no keyword hit, the remaining meaningful words (and the
 *   underscored phrase, e.g. "car wash" -> "car_wash") are emitted as literal
 *   values across {@link PROBE_KEYS}. These are guesses: a probe that returns
 *   no elements means "not understood", never "no competitors".
 * Stage 3 (none): nothing meaningful to query. The caller must stop with
 *   INDUSTRY_NOT_RESOLVED rather than fabricate or imply an empty market.
 */
export function resolveIndustry(businessType: string): IndustryResolution {
  const tokens = normalizeTokens(businessType);

  if (tokens.length === 0) {
    return { tags: [], stage: "none", matched: null };
  }

  const fromMap = (key: string): IndustryResolution => {
    const tags = OSM_CATEGORY_MAP[key];
    return tags.length > 0
      ? { tags, stage: "map", matched: key }
      : { tags: [], stage: "none", matched: key };
  };

  const full = tokens.join(" ");
  if (Object.hasOwn(OSM_CATEGORY_MAP, full)) return fromMap(full);

  // Contiguous multi-word phrases, longest window first (most specific wins).
  for (let window = Math.min(3, tokens.length); window >= 2; window--) {
    for (let start = 0; start + window <= tokens.length; start++) {
      const phrase = tokens.slice(start, start + window).join(" ");
      if (Object.hasOwn(OSM_CATEGORY_MAP, phrase)) return fromMap(phrase);
    }
  }

  // Individual, non-generic words, head noun (last word) first.
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (STOPWORDS.has(token)) continue;
    if (Object.hasOwn(OSM_CATEGORY_MAP, token)) return fromMap(token);
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

// Three independently operated public global instances from the OpenStreetMap
// community instance list, tried in this order. maps.mail.ru is slow (a 5 km
// cafe query took 33 s on 2026-09-25 UTC) but answered while the other two
// returned 504s or hung, so it is the last resort rather than unused.
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
] as const;

// Failover schedule. Each attempt goes to an instance not tried yet in this
// run; only when all have failed is one retried (the one that failed longest
// ago, after a short pause), and never one that still has an attempt in
// flight. When nothing has answered `hedgeDelayMs` after the latest start, the
// next instance is started in parallel (at most `maxParallelAttempts` at
// once), so a hung instance never consumes the others' share of the stage
// budget. A failed attempt is replaced at once.
export const OVERPASS_FAILOVER = {
  maxAttempts: 4,
  maxParallelAttempts: 3,
  hedgeDelayMs: 7_000,
  // Per-attempt client timeout: as much of the 24 s discovery stage as one
  // attempt can take while the hedges still get a real chance (see
  // ANALYSIS_TIMING_BUDGETS in lib/analyze-market.ts).
  maxAttemptTimeoutMs: 21_000,
  minAttemptTimeoutMs: 2_500,
  // Pause before re-trying an instance that has already failed in this run.
  sameEndpointRetryDelayMs: 1_500,
  // Server-side [timeout:] for the query. At 10 s, loaded instances timed out
  // city-sized queries server-side (2026-09-25); 25 s gives them room to
  // finish. It is above the client timeout, so the client may give up first:
  // that attempt then counts as failed, like any other timeout.
  serverTimeoutSeconds: 25,
} as const;

export const DEFAULT_DISCOVERY_RADIUS_METERS = 8_000;

// Staged resolution (esp. the direct-tag probe) can produce many candidate tag
// clauses. Cap them so a single Overpass request stays polite and fast; the
// probe orders clauses most-specific-first, so the cap keeps the best guesses.
const MAX_TAG_CLAUSES = 24;
// Element cap in the `out` statement. Overpass returns elements in its own
// order (type, then ascending id), not by distance, so the cap must be large
// enough to hold every named match in the search circle; the caller sorts by
// distance. When a response hits the cap it is flagged `truncated` so the
// caller can narrow the radius instead of ranking an arbitrary subset.
export const OVERPASS_OUTPUT_LIMIT = 500;

/**
 * Set when the elements came from the discovery cache instead of a live
 * query: "fresh" is a result younger than CACHE_TTL.overpass, "stale" an
 * older one (up to CACHE_TTL.overpassStaleIfError) used only because every
 * live attempt failed. Either way `accessedAt` is when OpenStreetMap
 * originally answered, never the time it was read back.
 */
export type OverpassCacheUse = "fresh" | "stale";

export type OverpassQueryResult = {
  elements: OverpassElement[];
  /** True when this exact query was answered by Overpass (now, or cached). */
  queryPerformed: boolean;
  endpoint?: string;
  accessedAt: string;
  /** The exact Overpass QL that was sent, for reproducible citations. */
  query?: string;
  radiusMeters: number;
  /** True when the element cap was reached, so the set may be incomplete. */
  truncated: boolean;
  resolution: IndustryResolution;
  /** Absent for a live answer. */
  cache?: OverpassCacheUse;
};

/** Overpass QL for named features matching any tag pair within the circle. */
export function buildOverpassQuery(
  tagPairs: OsmTagPair[],
  lat: number,
  lon: number,
  radiusMeters: number
): string {
  const radius = Math.round(radiusMeters);
  const clauses = tagPairs
    .slice(0, MAX_TAG_CLAUSES)
    .map(
      ([key, value]) =>
        `nwr["${key}"="${value}"]["name"](around:${radius},${lat},${lon});`
    )
    .join("\n  ");

  return `[out:json][timeout:${OVERPASS_FAILOVER.serverTimeoutSeconds}];
(
  ${clauses}
);
out center tags ${OVERPASS_OUTPUT_LIMIT};`;
}

/**
 * A clickable, reproducible citation for an Overpass query: overpass-turbo
 * loads the exact query text into its editor. The bare API endpoint answers a
 * browser GET with HTTP 406, so it is not a usable link.
 */
export function overpassTurboUrl(query: string): string {
  return `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}`;
}

/**
 * Overpass reports server-side failures (query timeout, out of memory) as an
 * HTTP 200 JSON body whose `remark` says "runtime error", often next to an
 * empty or truncated `elements` array. That is a failed query, not a result.
 */
function runtimeErrorRemark(data: object): string | null {
  const remark = (data as { remark?: unknown }).remark;
  if (typeof remark !== "string") return null;
  return /runtime (error|remark)|timed out|out of memory/i.test(remark)
    ? remark
    : null;
}

async function fetchOverpassOnce(
  endpoint: string,
  query: string,
  options: RequestBudgetOptions
): Promise<{ elements: OverpassElement[]; accessedAt: string }> {
  const timed = createTimedSignal(
    options.signal,
    Math.min(
      OVERPASS_FAILOVER.maxAttemptTimeoutMs,
      options.budgetMs ?? OVERPASS_FAILOVER.maxAttemptTimeoutMs
    )
  );

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: timed.signal,
    });

    if (!res.ok) {
      throw new Error(`Overpass (${endpoint}) returned HTTP ${res.status}`);
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Overpass (${endpoint}) returned a non-JSON response`);
    }
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { elements?: unknown }).elements)
    ) {
      throw new Error(
        `Overpass (${endpoint}) returned a malformed payload without an elements array`
      );
    }
    const remark = runtimeErrorRemark(data);
    if (remark) {
      throw new Error(`Overpass (${endpoint}) reported a runtime error: ${remark}`);
    }
    return {
      elements: (data as { elements: OverpassElement[] }).elements,
      accessedAt: new Date().toISOString(),
    };
  } finally {
    timed.cleanup();
  }
}

type AttemptOutcome =
  | {
      id: number;
      ok: true;
      endpoint: string;
      value: { elements: OverpassElement[]; accessedAt: string; endpoint: string };
    }
  | { id: number; ok: false; error: unknown; endpoint: string };

/**
 * Run one query against the instance pool with hedged attempts across
 * distinct instances (see OVERPASS_FAILOVER), all inside the caller's
 * deadline. Resolves with the first successful response and aborts every
 * other in-flight attempt.
 */
async function fetchWithFailover(
  query: string,
  deadlineAt: number,
  parentSignal?: AbortSignal
): Promise<{ elements: OverpassElement[]; accessedAt: string; endpoint: string }> {
  const {
    maxAttempts,
    maxParallelAttempts,
    hedgeDelayMs,
    maxAttemptTimeoutMs,
    minAttemptTimeoutMs,
    sameEndpointRetryDelayMs,
  } = OVERPASS_FAILOVER;
  const stage = new AbortController();
  const abortFromParent = () => stage.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const inflight = new Map<number, Promise<AttemptOutcome>>();
  // Instances with an attempt in flight, and when each one last failed.
  const busy = new Set<string>();
  const failedAt = new Map<string, number>();
  let launched = 0;
  let lastError: unknown;
  // When the next attempt is due: at once at the start and after a failure,
  // otherwise one hedge delay after the latest start.
  let dueAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // An untried instance first (list order); otherwise the idle one that
  // failed longest ago. Undefined when every instance is busy.
  const pickEndpoint = (): string | undefined => {
    const idle = OVERPASS_ENDPOINTS.filter((endpoint) => !busy.has(endpoint));
    return (
      idle.find((endpoint) => !failedAt.has(endpoint)) ??
      idle.sort((left, right) => failedAt.get(left)! - failedAt.get(right)!)[0]
    );
  };

  const launch = (endpoint: string): void => {
    const id = launched++;
    busy.add(endpoint);
    dueAt = Date.now() + hedgeDelayMs;
    const budgetMs = Math.min(maxAttemptTimeoutMs, remainingBudgetMs(deadlineAt));
    inflight.set(
      id,
      fetchOverpassOnce(endpoint, query, { signal: stage.signal, budgetMs }).then(
        (value): AttemptOutcome => ({
          id,
          ok: true,
          endpoint,
          value: { ...value, endpoint },
        }),
        (error: unknown): AttemptOutcome => ({ id, ok: false, error, endpoint })
      )
    );
  };

  try {
    for (;;) {
      const endpoint =
        launched < maxAttempts &&
        inflight.size < maxParallelAttempts &&
        !stage.signal.aborted
          ? pickEndpoint()
          : undefined;
      const retryAt =
        endpoint === undefined || !failedAt.has(endpoint)
          ? -Infinity
          : failedAt.get(endpoint)! + sameEndpointRetryDelayMs;
      const startAt = Math.max(dueAt, retryAt);
      // An attempt that would get less than the minimum is not worth starting.
      const launchable =
        endpoint !== undefined && deadlineAt - startAt >= minAttemptTimeoutMs;
      const waitMs = startAt - Date.now();

      if (launchable && waitMs <= 0) {
        launch(endpoint);
        continue;
      }
      if (inflight.size === 0) {
        if (!launchable) break;
        // Only a retry pause stands between us and the next attempt.
        await abortableDelay(waitMs, stage.signal);
        if (stage.signal.aborted) break;
        launch(endpoint);
        continue;
      }
      const racers: Array<Promise<AttemptOutcome | "due">> = [...inflight.values()];
      if (launchable) {
        racers.push(
          new Promise<"due">((resolve) => {
            timer = setTimeout(() => resolve("due"), waitMs);
          })
        );
      }
      const next = await Promise.race(racers);
      clearTimeout(timer);
      if (next === "due") {
        // Nothing settled meanwhile, so the chosen instance is still right.
        if (launchable) launch(endpoint);
        continue;
      }
      inflight.delete(next.id);
      busy.delete(next.endpoint);
      if (next.ok) return next.value;
      lastError = next.error;
      failedAt.set(next.endpoint, Date.now());
      dueAt = Date.now();
    }
    throw (
      lastError ??
      parentSignal?.reason ??
      new Error("Overpass time budget exhausted")
    );
  } finally {
    clearTimeout(timer);
    stage.abort(new Error("Overpass attempt superseded"));
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

// ---- discovery cache ------------------------------------------------------

type CachedOverpassResult = {
  /** The exact query text, re-checked on read so keys can never collide. */
  query: string;
  endpoint: string;
  /** When OpenStreetMap answered: the data's real retrieval time. */
  accessedAt: string;
  truncated: boolean;
  elements: OverpassElement[];
};

/** Cache key for one query: the exact query text, versioned. */
export function overpassCacheKey(query: string): string {
  return `v1:${query}`;
}

function pointOf(element: OverpassElement): boolean {
  return (
    (element.lat ?? element.center?.lat) !== undefined &&
    (element.lon ?? element.center?.lon) !== undefined
  );
}

/**
 * Only what discovery reads: named, located elements with their id, position
 * and full tag set (tag values feed category matching, so none are dropped).
 * `truncated` is stored separately, so dropping unusable elements cannot
 * change it.
 */
function cacheableElements(elements: OverpassElement[]): OverpassElement[] {
  return elements.flatMap((element) => {
    if (!element.tags?.name?.trim() || !pointOf(element)) return [];
    return [
      {
        type: element.type,
        id: element.id,
        ...(element.lat !== undefined ? { lat: element.lat } : {}),
        ...(element.lon !== undefined ? { lon: element.lon } : {}),
        ...(element.center
          ? { center: { lat: element.center.lat, lon: element.center.lon } }
          : {}),
        tags: element.tags,
      },
    ];
  });
}

function isCachedOverpassResult(
  value: unknown,
  query: string
): value is CachedOverpassResult {
  if (!value || typeof value !== "object") return false;
  const cached = value as Partial<CachedOverpassResult>;
  return (
    cached.query === query &&
    typeof cached.endpoint === "string" &&
    typeof cached.accessedAt === "string" &&
    Number.isFinite(Date.parse(cached.accessedAt)) &&
    typeof cached.truncated === "boolean" &&
    Array.isArray(cached.elements) &&
    cached.elements.every(
      (element) =>
        element &&
        typeof element === "object" &&
        typeof element.type === "string" &&
        typeof element.id === "number"
    )
  );
}

/** The cached answer to this exact query, with its age, or null (fails open). */
async function readDiscoveryCache(
  query: string
): Promise<{ result: CachedOverpassResult; ageMs: number } | null> {
  try {
    const entry = await readCacheEntry<unknown>("overpass", overpassCacheKey(query));
    if (!entry || !isCachedOverpassResult(entry.data, query)) return null;
    // Age of the data itself (when OpenStreetMap answered), not of the write.
    const ageMs = Date.now() - Date.parse(entry.data.accessedAt);
    return ageMs <= CACHE_TTL.overpassStaleIfError
      ? { result: entry.data, ageMs }
      : null;
  } catch {
    return null;
  }
}

async function writeDiscoveryCache(result: CachedOverpassResult): Promise<void> {
  try {
    await writeCache<CachedOverpassResult>("overpass", overpassCacheKey(result.query), {
      ...result,
      elements: cacheableElements(result.elements),
    });
  } catch {
    // Never fail discovery over a cache write.
  }
}

export async function queryOverpassDetailed(
  businessType: string,
  lat: number,
  lon: number,
  radiusMeters = DEFAULT_DISCOVERY_RADIUS_METERS,
  options: RequestBudgetOptions = {}
): Promise<OverpassQueryResult> {
  const deadlineAt = Date.now() + (options.budgetMs ?? 24_000);
  const resolution = resolveIndustry(businessType);

  // Honest floor: nothing resolved to a live OSM tag, so there is nothing to
  // query. The caller stops with INDUSTRY_NOT_RESOLVED; no request is made.
  if (resolution.tags.length === 0) {
    return {
      elements: [],
      queryPerformed: false,
      accessedAt: new Date().toISOString(),
      radiusMeters,
      truncated: false,
      resolution,
    };
  }

  // The cache key is the exact query text, so a different center, radius or
  // tag set can never be served another query's answer.
  const query = buildOverpassQuery(resolution.tags, lat, lon, radiusMeters);
  const cached = await readDiscoveryCache(query);
  const fromCache = (
    entry: CachedOverpassResult,
    use: OverpassCacheUse
  ): OverpassQueryResult => ({
    elements: entry.elements,
    queryPerformed: true,
    endpoint: entry.endpoint,
    accessedAt: entry.accessedAt,
    query,
    radiusMeters,
    truncated: entry.truncated,
    resolution,
    cache: use,
  });

  if (cached && cached.ageMs <= CACHE_TTL.overpass) {
    logger.info("Overpass discovery served from cache", {
      accessedAt: cached.result.accessedAt,
    });
    return fromCache(cached.result, "fresh");
  }

  try {
    const result = await fetchWithFailover(query, deadlineAt, options.signal);
    const truncated = result.elements.length >= OVERPASS_OUTPUT_LIMIT;
    await writeDiscoveryCache({ ...result, query, truncated });
    return {
      ...result,
      queryPerformed: true,
      query,
      radiusMeters,
      truncated,
      resolution,
    };
  } catch (err) {
    // Stale-if-error: an older answer to this exact query beats no answer,
    // as long as the report says when it was retrieved (see analyze-market).
    // It is never re-saved, so it cannot pass itself off as fresh later.
    if (cached) {
      logger.warn("Overpass unavailable; using a stale cached discovery result", {
        accessedAt: cached.result.accessedAt,
        ...serializeError(err),
      });
      return fromCache(cached.result, "stale");
    }
    throw new SourceUnavailableError(
      "overpass",
      "Competitor discovery is temporarily unavailable.",
      err
    );
  }
}

export async function queryOverpass(
  businessType: string,
  lat: number,
  lon: number,
  radiusMeters = DEFAULT_DISCOVERY_RADIUS_METERS,
  options: RequestBudgetOptions = {}
): Promise<OverpassElement[]> {
  return (
    await queryOverpassDetailed(
      businessType,
      lat,
      lon,
      radiusMeters,
      options
    )
  ).elements;
}
