// Countries: the "could I actually take this job" axis, kept separate from both
// the fit score and the role family for the same reason those two are separate.
// A job in Bengaluru can be a perfect résumé match and still be unreachable.
//
// Modelled on lib/categories.ts deliberately — same shape, same trade-offs.
// Nothing is stored: a country is derived from `location` on read, so editing
// the table below (or `countries` in profile.toml) re-classifies the whole queue
// with no migration and no backfill.
//
// The pattern table was seeded from the 577 distinct location strings actually
// in the queue, not from imagination. Those strings are far messier than a
// country field: 208 are semicolon-joined multi-location ("Remote, Canada;
// Remote, United Kingdom; Remote, US" — which IS a US job), many are bare cities
// with no country named ("London", "Dublin", "Bengaluru"), and ~300 are not
// locations at all ("Hybrid" x197, "Distributed" x43, "In-Office" x39, "N/A",
// "LOCATION"). Hence a real THIRD bucket: `unknown`, which is never hidden.

import { matchesTerm } from "./match";
import { loadProfile, MissingProfileError } from "./profile";

/** One country. `id` is the stable key; `label` is what profile.toml names it by. */
export interface Country {
  id: string;
  label: string;
  /** Country names, abbreviations, regions, and the cities that appear BARE. */
  patterns: string[];
}

/** No pattern matched and no source scope applied. Never hidden — see locationBucket. */
export const UNKNOWN = "unknown";

/**
 * Feeds that are country-scoped by construction, so an uninformative location
 * string still tells you the country.
 *
 * This is what keeps JSearch in the queue. `lib/sources/jsearch.ts` hardcodes
 * `country=us`, and its remote listings come back with job_location "Anywhere"
 * and null city/state/country — 66 rows, which are 41 of the 66 jobs scoring
 * >= 70 in the entire queue. Reading "Anywhere" as an unknown country would
 * bury the best of the queue; reading it as foreign would delete it.
 *
 * USAJOBS is the US federal jobs board. Adzuna is scoped by
 * `profile.adzuna.country`, which is read at lookup time rather than listed here.
 *
 * Checked AFTER the pattern table on purpose: a JSearch row that genuinely says
 * "London, United Kingdom" must still classify as the UK.
 */
export const SOURCE_SCOPE: Record<string, string> = { jsearch: "us", usajobs: "us" };

/**
 * Every country the queue has produced, plus the obvious ones it has not yet.
 *
 * Order is specificity, not preference: "northern ireland" must be checked
 * before "ireland", so the UK entry precedes Ireland. Preference is not in this
 * table at all — it is `countries` in profile.toml, applied by activeCountries().
 *
 * Cities are included ONLY where they appear in the queue with no country beside
 * them, and only where they are unambiguous. Deliberately absent:
 *   - "cambridge", "birmingham", "newcastle", "victoria", "kingston", "san jose"
 *     — each names a place in two different countries.
 *   - "ca" — Canada's code and California's abbreviation both, in the same feed
 *     ("CA-Toronto, CA-Montreal" vs "San Francisco, CA").
 *   - the long tail of small towns RemoteOK ships ("Airdrie", "Wisbech",
 *     "Bunbury", "Kotalpur"). Enumerating world geography is not the job; those
 *     land in `unknown` and stay visible, and lib/sources/remoteok.ts drops the
 *     non-technical postings they come from before they ever reach the store.
 */
export const COUNTRIES: Country[] = [
  {
    id: "us",
    label: "United States",
    patterns: [
      "united states",
      "usa",
      "u.s.a.",
      "u.s.",
      "us",
      "puerto rico",
      // US-inclusive regional markers. A posting scoped to "North America" or
      // "AMER" is one you can take from here, which is the question being asked.
      "north america",
      "americas",
      "amer",
      // States, spelled out. Two-letter codes are omitted on purpose: they
      // collide (CA, IN, OR, DE, ME) and the city beside them already carries
      // the signal in every string in the queue that uses one.
      "alabama",
      "alaska",
      "arizona",
      "arkansas",
      "california",
      "colorado",
      "connecticut",
      "delaware",
      "florida",
      "georgia",
      "hawaii",
      "idaho",
      "illinois",
      "indiana",
      "iowa",
      "kansas",
      "kentucky",
      "louisiana",
      "maine",
      "maryland",
      "massachusetts",
      "michigan",
      "minnesota",
      "mississippi",
      "missouri",
      "montana",
      "nebraska",
      "nevada",
      "new hampshire",
      "new jersey",
      "new mexico",
      "new york",
      "north carolina",
      "north dakota",
      "ohio",
      "oklahoma",
      "oregon",
      "pennsylvania",
      "rhode island",
      "south carolina",
      "south dakota",
      "tennessee",
      "texas",
      "utah",
      "vermont",
      "virginia",
      "washington",
      "west virginia",
      "wisconsin",
      "wyoming",
      "district of columbia",
      "washington dc",
      "dc",
      "d.c.",
      // Cities and office codes that appear with no state or country beside
      // them ("SF, NYC", "CHI, SEA, NYC, SF", "Chicago and NYC", "Boston").
      "new york city",
      "nyc",
      "san francisco",
      "sf",
      "bay area",
      "seattle",
      "sea",
      "chicago",
      "chi",
      "atlanta",
      "atl",
      "boston",
      "denver",
      "austin",
      "los angeles",
    ],
  },
  {
    id: "ca",
    label: "Canada",
    patterns: [
      "canada",
      "canadian",
      "toronto",
      "tor",
      "vancouver",
      "montreal",
      "montréal",
      "ottawa",
      "quebec",
      "québec",
      "winnipeg",
      "regina",
      "saskatoon",
      "edmonton",
      "calgary",
      "alberta",
      "ontario",
      "british columbia",
      "manitoba",
      "saskatchewan",
      "nova scotia",
      "halifax",
      "etobicoke",
      "brantford",
      "thunder bay",
      "dartmouth",
    ],
  },
  {
    id: "gb",
    label: "United Kingdom",
    // Before Ireland: "Northern Ireland" contains "ireland" as a whole term.
    patterns: [
      "united kingdom",
      "u.k.",
      "uk",
      "england",
      "scotland",
      "wales",
      "northern ireland",
      "great britain",
      "britain",
      "london",
      "greater london",
      "glasgow",
      "edinburgh",
      "belfast",
      "manchester",
      "newcastle upon tyne",
    ],
  },
  { id: "ie", label: "Ireland", patterns: ["ireland", "dublin", "dub", "cork", "galway"] },
  {
    id: "de",
    label: "Germany",
    patterns: [
      "germany",
      "deutschland",
      "berlin",
      "munich",
      "münchen",
      "hamburg",
      "frankfurt",
      "cologne",
    ],
  },
  { id: "fr", label: "France", patterns: ["france", "paris", "sophia antipolis"] },
  { id: "es", label: "Spain", patterns: ["spain", "españa", "madrid", "barcelona"] },
  {
    id: "nl",
    label: "Netherlands",
    patterns: ["netherlands", "holland", "amsterdam", "rotterdam", "utrecht", "eindhoven"],
  },
  {
    id: "it",
    label: "Italy",
    patterns: ["italy", "italia", "milan", "milano", "rome", "roma", "turin", "torino"],
  },
  { id: "pt", label: "Portugal", patterns: ["portugal", "lisbon", "lisboa", "porto"] },
  { id: "se", label: "Sweden", patterns: ["sweden", "stockholm", "gothenburg"] },
  { id: "dk", label: "Denmark", patterns: ["denmark", "copenhagen", "aarhus"] },
  { id: "no", label: "Norway", patterns: ["norway", "oslo", "stavanger", "bergen"] },
  { id: "fi", label: "Finland", patterns: ["finland", "helsinki"] },
  {
    id: "pl",
    label: "Poland",
    patterns: ["poland", "warsaw", "krakow", "kraków", "wroclaw", "gdansk"],
  },
  { id: "ro", label: "Romania", patterns: ["romania", "bucharest", "cluj"] },
  {
    id: "ch",
    label: "Switzerland",
    patterns: ["switzerland", "zurich", "zürich", "geneva", "lausanne"],
  },
  { id: "at", label: "Austria", patterns: ["austria", "vienna"] },
  { id: "be", label: "Belgium", patterns: ["belgium", "brussels", "bruxelles", "antwerp"] },
  { id: "cz", label: "Czechia", patterns: ["czechia", "czech republic", "prague"] },
  { id: "hu", label: "Hungary", patterns: ["hungary", "budapest"] },
  { id: "gr", label: "Greece", patterns: ["greece", "athens"] },
  { id: "bg", label: "Bulgaria", patterns: ["bulgaria", "sofia"] },
  { id: "rs", label: "Serbia", patterns: ["serbia", "belgrade"] },
  { id: "hr", label: "Croatia", patterns: ["croatia", "zagreb"] },
  { id: "me", label: "Montenegro", patterns: ["montenegro", "tivat"] },
  { id: "ee", label: "Estonia", patterns: ["estonia", "tallinn"] },
  { id: "lv", label: "Latvia", patterns: ["latvia", "riga"] },
  { id: "lt", label: "Lithuania", patterns: ["lithuania", "vilnius"] },
  { id: "ua", label: "Ukraine", patterns: ["ukraine", "kyiv", "kiev", "lviv", "uzhgorod"] },
  { id: "ru", label: "Russia", patterns: ["russia", "moscow", "st petersburg"] },
  { id: "is", label: "Iceland", patterns: ["iceland", "reykjavik"] },
  { id: "lu", label: "Luxembourg", patterns: ["luxembourg"] },
  { id: "tr", label: "Turkey", patterns: ["turkey", "türkiye", "istanbul", "ankara"] },
  { id: "il", label: "Israel", patterns: ["israel", "tel aviv", "jerusalem", "haifa"] },
  {
    id: "ae",
    label: "United Arab Emirates",
    patterns: ["united arab emirates", "uae", "dubai", "abu dhabi"],
  },
  { id: "sa", label: "Saudi Arabia", patterns: ["saudi arabia", "ksa", "riyadh", "jeddah"] },
  { id: "qa", label: "Qatar", patterns: ["qatar", "doha"] },
  { id: "eg", label: "Egypt", patterns: ["egypt", "cairo", "maadi"] },
  {
    id: "za",
    label: "South Africa",
    patterns: ["south africa", "johannesburg", "cape town", "durban"],
  },
  { id: "ng", label: "Nigeria", patterns: ["nigeria", "lagos", "abuja"] },
  { id: "ke", label: "Kenya", patterns: ["kenya", "nairobi"] },
  {
    id: "in",
    label: "India",
    // NOT "in" — the two-letter code is a preposition. "IN - Bengaluru" and
    // "IN-Bengaluru" are both covered by the city instead.
    patterns: [
      "india",
      "bengaluru",
      "bangalore",
      "mangaluru",
      "mumbai",
      "new delhi",
      "delhi",
      "hyderabad",
      "chennai",
      "pune",
      "kolkata",
      "gurgaon",
      "gurugram",
      "noida",
      "ahmedabad",
      "indore",
      "nagpur",
      "coimbatore",
      "kochi",
      "jaipur",
      "chandigarh",
      "surat",
      "patna",
      "guwahati",
      "thiruvananthapuram",
      "vijayawada",
      "nellore",
      "siliguri",
      "jamnagar",
      "bhubaneshwar",
      "karnataka",
      "maharashtra",
      "haryana",
      "kerala",
      "tamil nadu",
      "telangana",
      "gujarat",
    ],
  },
  { id: "pk", label: "Pakistan", patterns: ["pakistan", "karachi", "lahore", "islamabad"] },
  { id: "bd", label: "Bangladesh", patterns: ["bangladesh", "dhaka"] },
  { id: "np", label: "Nepal", patterns: ["nepal", "kathmandu"] },
  { id: "lk", label: "Sri Lanka", patterns: ["sri lanka", "colombo"] },
  // "phillipines" is the spelling RemoteOK actually ships.
  {
    id: "ph",
    label: "Philippines",
    patterns: ["philippines", "phillipines", "manila", "cebu"],
  },
  { id: "id", label: "Indonesia", patterns: ["indonesia", "jakarta", "bali", "surabaya"] },
  { id: "my", label: "Malaysia", patterns: ["malaysia", "kuala lumpur"] },
  { id: "sg", label: "Singapore", patterns: ["singapore"] },
  { id: "th", label: "Thailand", patterns: ["thailand", "bangkok"] },
  { id: "vn", label: "Vietnam", patterns: ["vietnam", "hanoi", "ho chi minh"] },
  {
    id: "jp",
    label: "Japan",
    patterns: ["japan", "tokyo", "osaka", "kyoto", "yokohama", "kawasaki"],
  },
  { id: "kr", label: "South Korea", patterns: ["south korea", "korea", "seoul"] },
  {
    id: "cn",
    label: "China",
    patterns: ["china", "shanghai", "beijing", "shenzhen", "guangzhou"],
  },
  { id: "hk", label: "Hong Kong", patterns: ["hong kong"] },
  { id: "tw", label: "Taiwan", patterns: ["taiwan", "taipei"] },
  { id: "mo", label: "Macau", patterns: ["macau", "macao"] },
  {
    id: "au",
    label: "Australia",
    patterns: [
      "australia",
      "sydney",
      "melbourne",
      "brisbane",
      "perth",
      "adelaide",
      "canberra",
      "hobart",
      "darwin",
      "gold coast",
      "geelong",
      "parramatta",
      "albury",
      "alice springs",
      "port macquarie",
      "queensland",
      "tasmania",
      "new south wales",
      "western australia",
    ],
  },
  {
    id: "nz",
    label: "New Zealand",
    patterns: ["new zealand", "auckland", "wellington", "christchurch"],
  },
  { id: "mx", label: "Mexico", patterns: ["mexico", "méxico", "guadalajara", "monterrey"] },
  {
    id: "br",
    label: "Brazil",
    patterns: [
      "brazil",
      "brasil",
      "sao paulo",
      "são paulo",
      "rio de janeiro",
      "brasilia",
      "brasília",
      "florianopolis",
      "florianópolis",
      "sorocaba",
    ],
  },
  { id: "ar", label: "Argentina", patterns: ["argentina", "buenos aires"] },
  { id: "cl", label: "Chile", patterns: ["chile", "santiago"] },
  { id: "co", label: "Colombia", patterns: ["colombia", "bogota", "bogotá", "medellin"] },
  { id: "pe", label: "Peru", patterns: ["peru", "perú", "lima", "chiclayo", "arequipa"] },
  { id: "uy", label: "Uruguay", patterns: ["uruguay", "montevideo"] },
  { id: "ni", label: "Nicaragua", patterns: ["nicaragua", "managua"] },
  { id: "cr", label: "Costa Rica", patterns: ["costa rica"] },
  { id: "jm", label: "Jamaica", patterns: ["jamaica", "montego bay"] },
  { id: "bs", label: "Bahamas", patterns: ["bahamas", "nassau", "marsh harbour"] },
  { id: "bb", label: "Barbados", patterns: ["barbados", "bridgetown"] },
  { id: "tt", label: "Trinidad and Tobago", patterns: ["trinidad", "tobago", "piarco"] },
  { id: "mv", label: "Maldives", patterns: ["maldives", "malé"] },
  { id: "om", label: "Oman", patterns: ["oman", "muscat"] },
];

/** The default when profile.toml is absent — the fresh-clone and CI case. */
export const DEFAULT_COUNTRIES = ["us"];

/** Where a job sits relative to the countries you named. */
export type LocationBucket = "allowed" | "foreign" | "unknown";

/**
 * Ranking weights, positive so nothing is ever pushed below an unscored row.
 *
 * `unknown` sits well above `foreign` and below `allowed` because the unknown
 * bucket is mostly domestic employers with a sloppy field — "Hybrid",
 * "Distributed", "In-Office", "N/A" are 299 greenhouse rows from companies you
 * are targeting on purpose. Guessing "foreign" there would hide them.
 */
export const LOCATION_WEIGHTS: Record<LocationBucket, number> = {
  allowed: 20,
  unknown: 8,
  foreign: 0,
};

function scopeOf(source?: string): string | undefined {
  if (!source) return undefined;
  if (source === "adzuna") {
    try {
      return loadProfile().adzuna.country.toLowerCase();
    } catch (err) {
      if (!(err instanceof MissingProfileError)) throw err;
      return undefined;
    }
  }
  return SOURCE_SCOPE[source];
}

const hits = (loc: string, c: Country) => c.patterns.some((p) => matchesTerm(loc, p));

// 577 distinct strings against ~600 patterns, re-walked for every row of every
// ORDER BY. Memoized on (location, source) so the table is scanned once per
// distinct string rather than once per row. Cleared by resetCountryCache().
const memo = new Map<string, string>();

/**
 * Which country is this posting in? Returns a COUNTRIES id, or UNKNOWN.
 *
 * Resolution order, and why each step is where it is:
 *
 *  1. Any ALLOWED country's pattern anywhere in the string wins. Any-match-wins
 *     is what makes "Remote, Canada; Remote, United Kingdom; Remote, US" a US
 *     job — which it is. Matching the whole string rather than splitting it on
 *     ";" is equivalent here and simpler: every separator in the data is
 *     non-alphanumeric, so matchesTerm's boundaries already fall in the right
 *     places.
 *  2. Otherwise the first FOREIGN country whose pattern hits.
 *  3. Otherwise the source's scope, if it has one (see SOURCE_SCOPE). Third, not
 *     first, so a JSearch row that names a real foreign city still classifies by
 *     the city.
 *  4. Otherwise UNKNOWN.
 */
export function countryOf(location: string, source?: string): string {
  const key = `${source ?? ""} ${location}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const loc = location.toLowerCase();
  const allowed = activeCountries();
  let resolved = UNKNOWN;

  for (const c of COUNTRIES) {
    if (allowed.has(c.id) && hits(loc, c)) {
      resolved = c.id;
      break;
    }
  }
  if (resolved === UNKNOWN) {
    for (const c of COUNTRIES) {
      if (!allowed.has(c.id) && hits(loc, c)) {
        resolved = c.id;
        break;
      }
    }
  }
  if (resolved === UNKNOWN) resolved = scopeOf(source) ?? UNKNOWN;

  memo.set(key, resolved);
  return resolved;
}

/**
 * allowed / foreign / unknown. `unknown` is a real answer, not a synonym for
 * foreign: it is what the UI keeps visible, because a wrong "foreign" hides a
 * job you could have taken and a wrong "unknown" only fails to rank it up.
 */
export function locationBucket(location: string, source?: string): LocationBucket {
  const id = countryOf(location, source);
  if (id === UNKNOWN) return UNKNOWN;
  return activeCountries().has(id) ? "allowed" : "foreign";
}

/** Ranking preference for a posting's location. Moves ORDER BY only. */
export function locationWeight(location: string, source?: string): number {
  return LOCATION_WEIGHTS[locationBucket(location, source)];
}

let cached: Set<string> | null = null;

/**
 * The country ids in force: profile.toml's `match.countries`, resolved to ids.
 *
 * `countries` is REQUIRED in the schema and has no default — that is the "there
 * is no anywhere option" rule made structural. A name the table doesn't know
 * throws rather than being ignored, because silently dropping a country someone
 * wrote is how a targeting change appears to do nothing.
 *
 * Falls back to DEFAULT_COUNTRIES only when profile.toml is ABSENT, the way
 * activeCategories() does, since profile/ is gitignored and missing in CI.
 * Cached for process life: editing profile.toml needs a `npm run dev` restart.
 */
export function activeCountries(): Set<string> {
  if (cached) return cached;
  let names: string[];
  try {
    names = loadProfile().match.countries;
  } catch (err) {
    if (!(err instanceof MissingProfileError)) throw err;
    names = DEFAULT_COUNTRIES;
  }
  cached = new Set(names.map(resolveCountry));
  return cached;
}

/** Map a profile.toml country name ("United States", "us") to a COUNTRIES id. */
function resolveCountry(name: string): string {
  const n = name.toLowerCase().trim();
  const found = COUNTRIES.find(
    (c) => c.id === n || c.label.toLowerCase() === n || c.patterns.includes(n),
  );
  if (!found) {
    throw new Error(
      `Unknown country ${JSON.stringify(name)} in profile.toml [match].countries. ` +
        `Use a name or code from lib/locations.ts, e.g. ${COUNTRIES.slice(0, 4)
          .map((c) => `"${c.label}"`)
          .join(", ")}.`,
    );
  }
  return found.id;
}

/** Test seam: drop the cached read of profile.toml and the per-string memo. */
export function resetCountryCache(): void {
  cached = null;
  memo.clear();
}
