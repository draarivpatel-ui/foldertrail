// Garmin waypoint icon numbers, as stored in a GDB waypoint record (docs/FORMAT.md §5.1, field 7), mapped to the GPX
// <sym> names that Garmin software and devices use (for example 'Flag, Blue' or 'Summit').
//
// Clean-room table (decision B31). It is written in our own words from public sources, and every entry's sources are
// recorded in docs/research/symbols-sources.md, which test/symbols.test.js keeps in step with this file.
// Nothing here has been checked against a real BaseCamp library yet; that is Gate 1 (docs/FORMAT.md §13).
//
// - The GDB icon number is NOT the Garmin device protocol symbol number: GDB numbers are a dense index (0, 1, 2, ...)
//   while device numbers are grouped (marine 0-193, land 8192-8363, aviation 16384-16402). The comments below give the
//   device range each block corresponds to, as a reading aid only.
// - An icon number that is not in the table gets no <sym>: lookup() returns "" and never guesses.
// - Custom symbols (which GPSBabel reports at GDB numbers 500-563) are deliberately not mapped; see the research note.

/**
 * One row of the table.
 * @typedef {Readonly<{ icon: number, sym: string }>} SymbolEntry
 */

/**
 * GDB icons 0-248. The number-to-icon order is given by two sources that agree on all 249 entries, and the icons
 * 0-220 are also in Garmin's own device interface specification (see the research note for each entry).
 * @type {ReadonlyArray<readonly [number, string]>}
 */
const AGREED = [
  // 0-19: Marine symbols. Garmin device symbols 0-19 (white anchor ... white wreck).
  [0, 'Anchor'],
  [1, 'Bell'],
  [2, 'Diamond, Green'],
  [3, 'Diamond, Red'],
  [4, 'Diver Down Flag 1'],
  [5, 'Diver Down Flag 2'],
  [6, 'Bank'],
  [7, 'Fishing Area'],
  [8, 'Gas Station'],
  [9, 'Horn'],
  [10, 'Residence'],
  [11, 'Restaurant'],
  [12, 'Light'],
  [13, 'Bar'],
  [14, 'Skull and Crossbones'],
  [15, 'Square, Green'],
  [16, 'Square, Red'],
  [17, 'Buoy, White'],
  [18, 'Waypoint'],
  [19, 'Shipwreck'],
  // 20-36: Man overboard, map buoys ("navaids"), white dot and radio beacon. Device symbols 21-37: the GDB list
  // skips the device's transparent "null" symbol (20), so here the GDB number is the device number minus 1.
  [20, 'Man Overboard'],
  [21, 'Navaid, Amber'],
  [22, 'Navaid, Black'],
  [23, 'Navaid, Blue'],
  [24, 'Navaid, Green'],
  [25, 'Navaid, Green/Red'],
  [26, 'Navaid, Green/White'],
  [27, 'Navaid, Orange'],
  [28, 'Navaid, Red'],
  [29, 'Navaid, Red/Green'],
  [30, 'Navaid, Red/White'],
  [31, 'Navaid, Violet'],
  [32, 'Navaid, White'],
  [33, 'Navaid, White/Green'],
  [34, 'Navaid, White/Red'],
  [35, 'Dot, White'],
  [36, 'Radio Beacon'],
  // 37-65: Points of interest. Device symbols 150-179.
  [37, 'Boat Ramp'],
  [38, 'Campground'],
  [39, 'Restroom'],
  [40, 'Shower'],
  [41, 'Drinking Water'],
  [42, 'Telephone'],
  [43, 'Medical Facility'],
  [44, 'Information'],
  [45, 'Parking Area'],
  [46, 'Park'],
  [47, 'Picnic Area'],
  [48, 'Scenic Area'],
  [49, 'Skiing Area'],
  [50, 'Swimming Area'],
  [51, 'Dam'],
  [52, 'Controlled Area'],
  [53, 'Danger Area'],
  [54, 'Restricted Area'],
  [55, 'Ball Park'],
  [56, 'Car'],
  [57, 'Hunting Area'],
  [58, 'Shopping Center'],
  [59, 'Lodging'],
  [60, 'Mine'],
  [61, 'Trail Head'],
  [62, 'Truck Stop'],
  [63, 'Exit'],
  [64, 'Flag'],
  [65, 'Circle with X'],
  // 66-106: Land symbols. Device symbols 8195-8246 (the GDB list skips the highway and intersection symbols).
  [66, 'Mile Marker'],
  [67, 'TracBack Point'],
  [68, 'Golf Course'],
  [69, 'City (Small)'],
  [70, 'City (Medium)'],
  [71, 'City (Large)'],
  [72, 'City (Capitol)'],
  [73, 'Amusement Park'],
  [74, 'Bowling'],
  [75, 'Car Rental'],
  [76, 'Car Repair'],
  [77, 'Fast Food'],
  [78, 'Fitness Center'],
  [79, 'Movie Theater'],
  [80, 'Museum'],
  [81, 'Pharmacy'],
  [82, 'Pizza'],
  [83, 'Post Office'],
  [84, 'RV Park'],
  [85, 'School'],
  [86, 'Stadium'],
  [87, 'Department Store'],
  [88, 'Zoo'],
  [89, 'Convenience Store'],
  [90, 'Live Theater'],
  [91, 'Scales'],
  [92, 'Toll Booth'],
  [93, 'Bridge'],
  [94, 'Building'],
  [95, 'Cemetery'],
  [96, 'Church'],
  [97, 'Civil'],
  [98, 'Crossing'],
  [99, 'Ghost Town'],
  [100, 'Levee'],
  [101, 'Military'],
  [102, 'Oil Field'],
  [103, 'Tunnel'],
  [104, 'Beach'],
  [105, 'Forest'],
  [106, 'Summit'],
  // 107-116: Aviation symbols. Device symbols 16384-16402 (the GDB list skips the approach and radio-aid symbols).
  [107, 'Airport'],
  [108, 'Heliport'],
  [109, 'Private Field'],
  [110, 'Soft Field'],
  [111, 'Tall Tower'],
  [112, 'Short Tower'],
  [113, 'Glider Area'],
  [114, 'Ultralight Area'],
  [115, 'Parachute Area'],
  [116, 'Seaplane Base'],
  // 117-139: Geocaches, Rino contacts and water hydrant. Device symbols 8255-8282.
  [117, 'Geocache'],
  [118, 'Geocache Found'],
  [119, 'Contact, Afro'],
  [120, 'Contact, Alien'],
  [121, 'Contact, Ball Cap'],
  [122, 'Contact, Big Ears'],
  [123, 'Contact, Biker'],
  [124, 'Contact, Bug'],
  [125, 'Contact, Cat'],
  [126, 'Contact, Dog'],
  [127, 'Contact, Dreadlocks'],
  [128, 'Contact, Female1'],
  [129, 'Contact, Female2'],
  [130, 'Contact, Female3'],
  [131, 'Contact, Goatee'],
  [132, 'Contact, Kung-Fu'],
  [133, 'Contact, Pig'],
  [134, 'Contact, Pirate'],
  [135, 'Contact, Ranger'],
  [136, 'Contact, Smiley'],
  [137, 'Contact, Spike'],
  [138, 'Contact, Sumo'],
  [139, 'Water Hydrant'],
  // 140-164: Markers, bike trail, and the outdoor and fishing set. Device symbols 8284-8293, 8249-8253 and 181-193.
  [140, 'Flag, Red'],
  [141, 'Flag, Blue'],
  [142, 'Flag, Green'],
  [143, 'Pin, Red'],
  [144, 'Pin, Blue'],
  [145, 'Pin, Green'],
  [146, 'Block, Red'],
  [147, 'Block, Blue'],
  [148, 'Block, Green'],
  [149, 'Bike Trail'],
  [150, 'Fishing Hot Spot Facility'],
  [151, 'Police Station'],
  [152, 'Ski Resort'],
  [153, 'Ice Skating'],
  [154, 'Wrecker'],
  [155, 'Anchor Prohibited'],
  [156, 'Beacon'],
  [157, 'Coast Guard'],
  [158, 'Reef'],
  [159, 'Weed Bed'],
  [160, 'Dropoff'],
  [161, 'Dock'],
  [162, 'Marina'],
  [163, 'Bait and Tackle'],
  [164, 'Stump'],
  // 165-220: Shapes, letters and numbers in red, green and blue. Device symbols 8294-8353.
  [165, 'Circle, Red'],
  [166, 'Circle, Green'],
  [167, 'Circle, Blue'],
  [168, 'Diamond, Blue'],
  [169, 'Oval, Red'],
  [170, 'Oval, Green'],
  [171, 'Oval, Blue'],
  [172, 'Rectangle, Red'],
  [173, 'Rectangle, Green'],
  [174, 'Rectangle, Blue'],
  [175, 'Square, Blue'],
  [176, 'Letter A, Red'],
  [177, 'Letter A, Green'],
  [178, 'Letter A, Blue'],
  [179, 'Letter B, Red'],
  [180, 'Letter B, Green'],
  [181, 'Letter B, Blue'],
  [182, 'Letter C, Red'],
  [183, 'Letter C, Green'],
  [184, 'Letter C, Blue'],
  [185, 'Letter D, Red'],
  [186, 'Letter D, Green'],
  [187, 'Letter D, Blue'],
  [188, 'Number 0, Red'],
  [189, 'Number 0, Green'],
  [190, 'Number 0, Blue'],
  [191, 'Number 1, Red'],
  [192, 'Number 1, Green'],
  [193, 'Number 1, Blue'],
  [194, 'Number 2, Red'],
  [195, 'Number 2, Green'],
  [196, 'Number 2, Blue'],
  [197, 'Number 3, Red'],
  [198, 'Number 3, Green'],
  [199, 'Number 3, Blue'],
  [200, 'Number 4, Red'],
  [201, 'Number 4, Green'],
  [202, 'Number 4, Blue'],
  [203, 'Number 5, Red'],
  [204, 'Number 5, Green'],
  [205, 'Number 5, Blue'],
  [206, 'Number 6, Red'],
  [207, 'Number 6, Green'],
  [208, 'Number 6, Blue'],
  [209, 'Number 7, Red'],
  [210, 'Number 7, Green'],
  [211, 'Number 7, Blue'],
  [212, 'Number 8, Red'],
  [213, 'Number 8, Green'],
  [214, 'Number 8, Blue'],
  [215, 'Number 9, Red'],
  [216, 'Number 9, Green'],
  [217, 'Number 9, Blue'],
  [218, 'Triangle, Blue'],
  [219, 'Triangle, Green'],
  [220, 'Triangle, Red'],
  // 221-248: Added in MapSource 6.12 and later; not in the 2006 device specification.
  [221, 'Contact, Blonde'],
  [222, 'Contact, Clown'],
  [223, 'Contact, Glasses'],
  [224, 'Contact, Panda'],
  [225, 'Multi-Cache'],
  [226, 'Letterbox Cache'],
  [227, 'Puzzle Cache'],
  [228, 'Library'],
  [229, 'Ground Transportation'],
  [230, 'City Hall'],
  [231, 'Winery'],
  [232, 'ATV'],
  [233, 'Big Game'],
  [234, 'Blind'],
  [235, 'Blood Trail'],
  [236, 'Cover'],
  [237, 'Covey'],
  [238, 'Food Source'],
  [239, 'Furbearer'],
  [240, 'Lodge'],
  [241, 'Small Game'],
  [242, 'Animal Tracks'],
  [243, 'Treed Quarry'],
  [244, 'Tree Stand'],
  [245, 'Truck'],
  [246, 'Upland Game'],
  [247, 'Waterfowl'],
  [248, 'Water Source'],
];

/**
 * GDB icons 249-265, which GPSBabel lists as new in BaseCamp 4.8.13. PROVISIONAL: the icon NUMBERS rest on that single
 * source (read only as a cross-check), and only 8 of the 17 names are attested elsewhere. Kept as one block so it can
 * be dropped, or confirmed, after Gate 1.
 * @type {ReadonlyArray<readonly [number, string]>}
 */
const PROVISIONAL_BASECAMP_48 = [
  [249, 'Dog Running'],
  [250, 'Dog Pointing'],
  [251, 'Dog Treed'],
  [252, 'Dog Sitting'],
  [253, 'Dog Unknown'],
  [254, 'Bank, Euro'],
  [255, 'Bank, Pound'],
  [256, 'Bank, Yen'],
  [257, 'Sad Face'],
  [258, 'Favorite'],
  [259, 'Ferry'],
  [260, 'Funicular'],
  [261, 'Railway'],
  [262, 'Parking, Pay'],
  [263, 'Parking, Euro'],
  [264, 'Parking, Euro Pay'],
  [265, 'Hospital, Euro'],
];

/**
 * The whole table, sorted by icon number. The array and every row are frozen.
 * @type {ReadonlyArray<SymbolEntry>}
 */
export const SYMBOLS = Object.freeze(
  [...AGREED, ...PROVISIONAL_BASECAMP_48].map(([icon, sym]) => Object.freeze({ icon, sym })),
);

/** @type {ReadonlyMap<number, string>} private index; never exported, because a Map cannot be frozen */
const BY_ICON = new Map(SYMBOLS.map((entry) => [entry.icon, entry.sym]));

/**
 * The GPX <sym> name for a GDB waypoint icon number, or "" when the number is not in the table.
 * Never throws: anything that is not an integer (a string, NaN, a fraction, a bigint, null, an object) gives "".
 * -0 counts as 0, which a u32 field cannot produce anyway.
 * @param {unknown} icon  the u32 icon field of a waypoint record
 * @returns {string}
 */
export function lookup(icon) {
  if (typeof icon !== 'number' || !Number.isInteger(icon)) return '';
  return BY_ICON.get(icon) ?? '';
}
